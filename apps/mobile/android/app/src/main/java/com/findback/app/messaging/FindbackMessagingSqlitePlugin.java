package com.findback.app.messaging;

import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteCursor;
import android.database.sqlite.SQLiteQuery;
import android.database.sqlite.SQLiteStatement;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.security.SecureRandom;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.regex.Pattern;

/**
 * Thin SQLite transport for the human-messaging history adapter.
 *
 * Deliberately NOT a messaging implementation: it owns one app-private database
 * file per validated account and an opaque handle, nothing else. The schema,
 * statements, identity binding, tombstones and ACK ordering all live in the
 * JavaScript adapter (`apps/mobile/src/services/messaging/`), so there is
 * exactly one schema and one policy owner.
 *
 * Security and durability rules:
 *   - the file name is fixed and derived only from a validated UUID inside
 *     {@code getNoBackupFilesDir()}; JavaScript never supplies a path, and ATTACH /
 *     DETACH / load_extension / VACUUM are refused so no command can reach
 *     another file,
 *   - {@code PRAGMA} is limited to the four durability settings the adapter
 *     needs, with values restricted to the durable ones,
 *   - exactly one SQL statement per call; parameters are bound, never inlined,
 *   - WAL + synchronous=FULL + foreign_keys=ON are applied and then read back
 *     at open; a database that does not report all three is closed and the open
 *     fails, so no persistence receipt can be issued on a non-durable file,
     *   - one live owner per account, including pending open/close and plugin
     *     recreation; each adapter's multi-call transaction has only one writer,
     *   - commands run on one serialized lane and close follows dispatched work,
 *   - the handle is 32 random bytes, is not derived from the account, and is
 *     invalidated before the close task is queued,
 *   - no network access, no synchronous {@code @JavascriptInterface}, no
 *     logging of SQL, parameters or platform exception text (parameters carry
 *     message bodies).
 */
@CapacitorPlugin(name = "FindbackMessagingSqlite")
public class FindbackMessagingSqlitePlugin extends Plugin {

    static final String PREFERENCES = "findback_messaging_native";
    static final String INSTALLATION_KEY = "installation_id";
    static final String DATABASE_DIRECTORY = "messaging";
    static final String DATABASE_PREFIX = "messaging-v1-";
    static final String DATABASE_SUFFIX = ".sqlite3";

    /** Stable, consumer-safe failure text. Native/SQL text is never forwarded. */
    static final String MESSAGE_CLOSED = "Messaging storage is not open.";
    static final String MESSAGE_INVALID_REQUEST = "Messaging storage rejected an invalid request.";
    static final String MESSAGE_OPEN_FAILED = "Messaging storage could not be opened.";
    static final String MESSAGE_FAILED = "Messaging storage could not complete the request.";
    static final String MESSAGE_ALREADY_OPEN = "Messaging storage is already open for this account.";

    static final String CODE_CLOSED = "MESSAGING_STORAGE_CLOSED";
    static final String CODE_INVALID_REQUEST = "MESSAGING_STORAGE_INVALID_REQUEST";
    static final String CODE_OPEN_FAILED = "MESSAGING_STORAGE_OPEN_FAILED";
    static final String CODE_FAILED = "MESSAGING_STORAGE_FAILED";
    static final String CODE_ALREADY_OPEN = "MESSAGING_STORAGE_ALREADY_OPEN";

    private static final Pattern UUID_PATTERN = Pattern.compile(
            "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$");

    /**
     * The adapter needs exactly these pragmas. Anything else is refused so a
     * command cannot weaken durability or read foreign configuration.
     */
    private static final Pattern ALLOWED_PRAGMA = Pattern.compile(
            "^pragma\\s+(?:"
                    + "journal_mode\\s*=\\s*wal"
                    + "|synchronous\\s*=\\s*(?:full|2)"
                    + "|foreign_keys\\s*=\\s*(?:on|1)"
                    + "|busy_timeout\\s*=\\s*\\d{1,9}"
                    + "|journal_mode|synchronous|foreign_keys"
                    + ")$");

    /** Refused because they touch files or extensions outside this database. */
    private static final Pattern FORBIDDEN_KEYWORD = Pattern.compile(
            "\\b(?:attach|detach|load_extension|vacuum)\\b");

    private static final int MAX_SQL_LENGTH = 100_000;
    private static final int MAX_PARAMETERS = 64;
    private static final int HANDLE_BYTES = 32;
    private static final long MAX_SAFE_INTEGER = 9_007_199_254_740_991L;

    private final Map<String, Handle> handles = new ConcurrentHashMap<>();
    // Process-wide: a replacement plugin must not reopen a file still owned by
    // its predecessor's pending teardown. A failed close retains its lease.
    private static final Map<String, Object> accountOwners = new ConcurrentHashMap<>();
    private final SecureRandom random = new SecureRandom();
    private volatile boolean destroyed;

    /** One lane: transactions, close and open are strictly ordered. */
    private final ExecutorService lane = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "findback-messaging-sqlite");
        thread.setDaemon(true);
        return thread;
    });

    /** One open database. The account scope is the handle-to-file binding. */
    private static final class Handle {
        final DatabaseConnection connection;
        final String accountId;
        final Object owner;
        volatile boolean invalid;

        Handle(DatabaseConnection connection, String accountId, Object owner) {
            this.connection = connection;
            this.accountId = accountId;
            this.owner = owner;
        }
    }

    /** Acquisition returns ownership before verification, so every failure can
     * close the acquired resource or retain it for lifecycle cleanup. */
    interface DatabaseConnection {
        SQLiteDatabase database();
        void verify() throws Exception;
        void close();
    }

    private interface LaneWork {
        /** Returns the resolve payload, or null to resolve with no data. */
        JSObject run() throws Exception;
    }

    private static final class StorageException extends Exception {
        private static final long serialVersionUID = 1L;

        final String code;

        StorageException(String message, String code) {
            super(message);
            this.code = code;
        }
    }

    private boolean runOnLane(PluginCall call, LaneWork work) {
        if (destroyed) {
            call.reject(MESSAGE_CLOSED, CODE_CLOSED);
            return false;
        }
        try {
            lane.execute(() -> {
                JSObject result;
                try {
                    result = work.run();
                } catch (StorageException expected) {
                    call.reject(expected.getMessage(), expected.code);
                    return;
                } catch (Exception unexpected) {
                    // Never forward the platform exception: it can echo SQL and
                    // therefore stored message bodies.
                    call.reject(MESSAGE_FAILED, CODE_FAILED);
                    return;
                }
                if (result == null) {
                    call.resolve();
                } else {
                    call.resolve(result);
                }
            });
        } catch (RejectedExecutionException shuttingDown) {
            call.reject(MESSAGE_FAILED, CODE_FAILED);
            return false;
        }
        return true;
    }

    // ---------------------------------------------------------------- identity

    @PluginMethod
    public void installationId(PluginCall call) {
        runOnLane(call, () -> {
            JSObject result = new JSObject();
            result.put("id", readInstallationId());
            return result;
        });
    }

    /**
     * Random per-installation UUID, persisted before it is handed out so a
     * restart reopens the same database under the same scope. Stored in
     * app-private preferences; the app sets {@code allowBackup="false"}, so this
     * identity and the message database are never carried to another device.
     */
    private String readInstallationId() throws StorageException {
        SharedPreferences preferences = getContext()
                .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
        String stored = preferences.getString(INSTALLATION_KEY, null);
        if (stored != null) {
            // Fail closed on a corrupt identity instead of silently minting a new
            // one and orphaning an existing database.
            if (!UUID_PATTERN.matcher(stored).matches()) {
                throw new StorageException(MESSAGE_FAILED, CODE_FAILED);
            }
            return stored;
        }
        String created = java.util.UUID.randomUUID().toString();
        // commit(), not apply(): the id must be on disk before it identifies a file.
        if (!preferences.edit().putString(INSTALLATION_KEY, created).commit()) {
            throw new StorageException(MESSAGE_FAILED, CODE_FAILED);
        }
        return created;
    }

    // -------------------------------------------------------------------- open

    @PluginMethod
    public synchronized void open(PluginCall call) {
        String accountId = call.getString("accountId");
        if (accountId == null || !UUID_PATTERN.matcher(accountId).matches()) {
            call.reject(MESSAGE_INVALID_REQUEST, CODE_INVALID_REQUEST);
            return;
        }
        if (destroyed) {
            call.reject(MESSAGE_CLOSED, CODE_CLOSED);
            return;
        }
        Object owner = new Object();
        if (accountOwners.putIfAbsent(accountId, owner) != null) {
            call.reject(MESSAGE_ALREADY_OPEN, CODE_ALREADY_OPEN);
            return;
        }
        boolean queued = runOnLane(call, () -> {
            Handle handle = null;
            String token = null;
            try {
                if (destroyed) throw new StorageException(MESSAGE_CLOSED, CODE_CLOSED);
                token = newHandle();
                handle = new Handle(openDatabase(accountId), accountId, owner);
                handle.invalid = true;
                // Track before verification. Failed cleanup remains reclaimable
                // by destroy, not just an orphaned process-wide reservation.
                while (handles.putIfAbsent(token, handle) != null) token = newHandle();
                handle.connection.verify();
                if (destroyed) throw new StorageException(MESSAGE_CLOSED, CODE_CLOSED);
                JSObject result = new JSObject();
                result.put("handle", token);
                handle.invalid = false;
                return result;
            } catch (Exception failure) {
                if (handle == null) {
                    // No connection returned: directory/open failures are safe
                    // to retry, including unexpected runtime/security failures.
                    accountOwners.remove(accountId, owner);
                } else {
                    handle.invalid = true;
                    try {
                        handle.connection.close();
                        handles.remove(token, handle);
                        accountOwners.remove(accountId, owner);
                    } catch (RuntimeException uncertainClose) {
                        // Keep both resource and lease until a later successful
                        // destroy cleanup. Never reopen an uncertain writer.
                    }
                }
                throw failure;
            }
        });
        if (!queued) accountOwners.remove(accountId, owner);
    }

    private String newHandle() {
        byte[] bytes = new byte[HANDLE_BYTES];
        random.nextBytes(bytes);
        return Base64.encodeToString(bytes, Base64.NO_WRAP | Base64.URL_SAFE | Base64.NO_PADDING);
    }

    DatabaseConnection openDatabase(String accountId) throws StorageException {
        File directory = new File(getContext().getNoBackupFilesDir(), DATABASE_DIRECTORY);
        if (!directory.isDirectory() && !directory.mkdirs()) {
            throw new StorageException(MESSAGE_OPEN_FAILED, CODE_OPEN_FAILED);
        }
        File file = new File(directory, DATABASE_PREFIX + accountId + DATABASE_SUFFIX);
        SQLiteDatabase database;
        try {
            // Deliberately NOT the ENABLE_WRITE_AHEAD_LOGGING flag: that flag makes
            // the framework pool open several connections, and synchronous /
            // foreign_keys are per-connection, so a second pooled connection would
            // not carry the settings verified here. Opening without it keeps the
            // pool at one connection, and WAL is then enabled on that connection.
            database = SQLiteDatabase.openDatabase(
                    file.getAbsolutePath(),
                    null,
                    SQLiteDatabase.OPEN_READWRITE
                            | SQLiteDatabase.CREATE_IF_NECESSARY
                            | SQLiteDatabase.NO_LOCALIZED_COLLATORS);
        } catch (RuntimeException failure) {
            throw new StorageException(MESSAGE_OPEN_FAILED, CODE_OPEN_FAILED);
        }
        return new DatabaseConnection() {
            @Override public SQLiteDatabase database() { return database; }
            @Override public void verify() throws StorageException { verifyDurability(database); }
            @Override public void close() { database.close(); }
        };
    }

    /**
     * Applies the durability settings and reads them back. Issuing a pragma is
     * not proof it took effect: SQLite returns the previous journal mode when a
     * change fails, and an in-memory database can never enter WAL.
     */
    private static void verifyDurability(SQLiteDatabase database) throws StorageException {
        applyPragma(database, "pragma journal_mode = wal");
        applyPragma(database, "pragma synchronous = full");
        applyPragma(database, "pragma foreign_keys = on");
        applyPragma(database, "pragma busy_timeout = 5000");

        String journalMode = queryText(database, "pragma journal_mode");
        Long synchronous = queryLong(database, "pragma synchronous");
        Long foreignKeys = queryLong(database, "pragma foreign_keys");
        if (!"wal".equals(journalMode)
                || synchronous == null || synchronous.longValue() != 2L
                || foreignKeys == null || foreignKeys.longValue() != 1L) {
            throw new StorageException(MESSAGE_OPEN_FAILED, CODE_OPEN_FAILED);
        }
    }

    private static void applyPragma(SQLiteDatabase database, String sql) {
        try (Cursor cursor = database.rawQuery(sql, null)) {
            // The pragma is applied when the statement is stepped, not compiled.
            cursor.moveToFirst();
        }
    }

    private static String queryText(SQLiteDatabase database, String sql) {
        try (Cursor cursor = database.rawQuery(sql, null)) {
            return cursor.moveToFirst() ? cursor.getString(0) : null;
        }
    }

    private static Long queryLong(SQLiteDatabase database, String sql) {
        try (Cursor cursor = database.rawQuery(sql, null)) {
            return cursor.moveToFirst() ? cursor.getLong(0) : null;
        }
    }

    // ---------------------------------------------------------------- commands

    @PluginMethod
    public void exec(PluginCall call) {
        String token = call.getString("handle");
        String sql = call.getString("sql");
        runOnLane(call, () -> {
            Handle handle = requireHandle(token);
            String statement = validateStatement(sql);
            if (statement.trim().toLowerCase(Locale.ROOT).startsWith("pragma")) {
                // `journal_mode = wal` returns a row. Android execSQL is for
                // statements without result rows; step/close it as a query.
                try (Cursor cursor = handle.connection.database().rawQueryWithFactory(
                        (database, driver, editTable, query) -> new SQLiteCursor(driver, editTable, query),
                        statement, null, null)) {
                    while (cursor.moveToNext()) {
                        // Drain the pragma result; the adapter reads it back
                        // through `all` before accepting the connection.
                    }
                }
            } else {
                handle.connection.database().execSQL(statement);
            }
            return null;
        });
    }

    @PluginMethod
    public void all(PluginCall call) {
        String token = call.getString("handle");
        String sql = call.getString("sql");
        runOnLane(call, () -> {
            Handle handle = requireHandle(token);
            String statement = validateStatement(sql);
            Object[] params = readArguments(call.getArray("params"));
            JSArray rows = new JSArray();
            try (Cursor cursor = handle.connection.database().rawQueryWithFactory(
                    (database, driver, editTable, query) -> {
                        bindQuery(query, params);
                        return new SQLiteCursor(driver, editTable, query);
                    }, statement, null, null)) {
                readRows(cursor, rows);
            }
            JSObject result = new JSObject();
            result.put("rows", rows);
            return result;
        });
    }

    @PluginMethod
    public void run(PluginCall call) {
        String token = call.getString("handle");
        String sql = call.getString("sql");
        JSArray params = call.getArray("params");
        runOnLane(call, () -> {
            Handle handle = requireHandle(token);
            String statement = validateStatement(sql);
            Object[] bound = readArguments(params);
            JSObject result = new JSObject();
            long changes = execute(handle.connection.database(), statement, bound);
            if (changes > MAX_SAFE_INTEGER) {
                throw new StorageException(MESSAGE_FAILED, CODE_FAILED);
            }
            result.put("changes", changes);
            return result;
        });
    }

    @PluginMethod
    public void close(PluginCall call) {
        String token = call.getString("handle");
        // Invalidate synchronously before queuing native close. Keep the map entry
        // until the lane closes it so lifecycle destruction can still reclaim it
        // if close races with the final cleanup task.
        Handle handle = token == null ? null : handles.get(token);
        if (handle == null) {
            call.reject(MESSAGE_CLOSED, CODE_CLOSED);
            return;
        }
        synchronized (handle) {
            if (handle.invalid) {
                call.reject(MESSAGE_CLOSED, CODE_CLOSED);
                return;
            }
            handle.invalid = true;
        }
        runOnLane(call, () -> {
            handle.connection.close();
            handles.remove(token, handle);
            accountOwners.remove(handle.accountId, handle.owner);
            return null;
        });
    }

    private Handle requireHandle(String token) throws StorageException {
        if (token == null || token.isEmpty()) {
            throw new StorageException(MESSAGE_CLOSED, CODE_CLOSED);
        }
        Handle handle = handles.get(token);
        if (handle == null || handle.invalid) {
            throw new StorageException(MESSAGE_CLOSED, CODE_CLOSED);
        }
        return handle;
    }

    @Override
    protected synchronized void handleOnDestroy() {
        if (destroyed) return;
        destroyed = true;
        for (Handle handle : handles.values()) {
            handle.invalid = true;
        }
        // Enqueue cleanup as a final lane task. This also catches handles opened
        // by an open() task that was already queued when destruction began.
        try {
            lane.execute(() -> {
                for (Map.Entry<String, Handle> entry : handles.entrySet()) {
                    Handle handle = entry.getValue();
                    handle.invalid = true;
                    try {
                        handle.connection.close();
                        handles.remove(entry.getKey(), handle);
                        accountOwners.remove(handle.accountId, handle.owner);
                    } catch (RuntimeException ignored) {
                        // Keep ownership when teardown is uncertain, including
                        // across plugin recreation. Process exit clears it.
                    }
                }
            });
        } catch (RejectedExecutionException ignored) {
            // The lane is already shutting down; the process is going away.
        }
        lane.shutdown();
        super.handleOnDestroy();
    }

    // --------------------------------------------------------------- statement

    /**
     * One statement, no file access, no pragma outside the durable allowlist.
     * String literals are stripped before the keyword checks so a literal cannot
     * hide (or trip) a match. Comments outside literals are not part of this
     * transport's SQL dialect: allowing a leading comment would bypass the
     * PRAGMA allowlist and command dispatch's first-keyword checks.
     */
    private static String validateStatement(String sql) throws StorageException {
        if (sql == null || sql.trim().isEmpty() || sql.length() > MAX_SQL_LENGTH) {
            throw new StorageException(MESSAGE_INVALID_REQUEST, CODE_INVALID_REQUEST);
        }
        String stripped = stripLiterals(sql).trim();
        if (stripped.endsWith(";")) {
            stripped = stripped.substring(0, stripped.length() - 1).trim();
        }
        if (stripped.isEmpty() || stripped.indexOf(';') >= 0) {
            throw new StorageException(MESSAGE_INVALID_REQUEST, CODE_INVALID_REQUEST);
        }
        String lower = stripped.toLowerCase(Locale.ROOT);
        // Commands must begin with an ASCII SQL keyword after whitespace. In
        // particular SQLite accepts a leading BOM that String.trim() retains;
        // accepting it would bypass both PRAGMA validation and dispatch.
        if (lower.charAt(0) < 'a' || lower.charAt(0) > 'z') {
            throw new StorageException(MESSAGE_INVALID_REQUEST, CODE_INVALID_REQUEST);
        }
        if (FORBIDDEN_KEYWORD.matcher(lower).find()) {
            throw new StorageException(MESSAGE_INVALID_REQUEST, CODE_INVALID_REQUEST);
        }
        if (lower.startsWith("pragma") && !ALLOWED_PRAGMA.matcher(lower).matches()) {
            throw new StorageException(MESSAGE_INVALID_REQUEST, CODE_INVALID_REQUEST);
        }
        return sql.trim();
    }

    /** Drops single-quoted literal content, keeping the quotes as boundaries. */
    private static String stripLiterals(String sql) throws StorageException {
        StringBuilder out = new StringBuilder(sql.length());
        boolean inLiteral = false;
        for (int index = 0; index < sql.length(); index++) {
            char current = sql.charAt(index);
            if (inLiteral) {
                if (current == '\'') {
                    if (index + 1 < sql.length() && sql.charAt(index + 1) == '\'') {
                        index++;
                    } else {
                        inLiteral = false;
                    }
                }
                continue;
            }
            if (current == '\'') {
                inLiteral = true;
                out.append('\'');
                continue;
            }
            if (index + 1 < sql.length()) {
                char next = sql.charAt(index + 1);
                if ((current == '-' && next == '-')
                        || (current == '/' && next == '*')
                        || (current == '*' && next == '/')) {
                    throw new StorageException(MESSAGE_INVALID_REQUEST, CODE_INVALID_REQUEST);
                }
            }
            out.append(current);
        }
        if (inLiteral) {
            throw new StorageException(MESSAGE_INVALID_REQUEST, CODE_INVALID_REQUEST);
        }
        return out.toString();
    }

    /**
     * Bind through SQLiteProgram's typed API for queries as well as DML. The
     * selectionArgs parameter of rawQuery is text-only and cannot represent
     * NULL, so the CursorFactory receives the compiled SQLiteQuery and binds
     * each original JSON value without coercion.
     */
    private static void bindQuery(SQLiteQuery query, Object[] values) {
        for (int index = 0; index < values.length; index++) {
            Object value = values[index];
            int parameter = index + 1;
            if (value == null) {
                query.bindNull(parameter);
            } else if (value instanceof Long) {
                query.bindLong(parameter, (Long) value);
            } else if (value instanceof Double) {
                query.bindDouble(parameter, (Double) value);
            } else {
                query.bindString(parameter, (String) value);
            }
        }
    }

    private static Object[] readArguments(JSArray params) throws StorageException {
        if (params == null) return new Object[0];
        int length = params.length();
        if (length > MAX_PARAMETERS) {
            throw new StorageException(MESSAGE_INVALID_REQUEST, CODE_INVALID_REQUEST);
        }
        Object[] values = new Object[length];
        for (int index = 0; index < length; index++) {
            Object value;
            try {
                value = params.get(index);
            } catch (JSONException malformed) {
                throw new StorageException(MESSAGE_INVALID_REQUEST, CODE_INVALID_REQUEST);
            }
            if (value == JSONObject.NULL) {
                values[index] = null;
            } else if (value instanceof Integer) {
                values[index] = ((Integer) value).longValue();
            } else if (value instanceof Long) {
                long integer = (Long) value;
                if (integer > MAX_SAFE_INTEGER || integer < -MAX_SAFE_INTEGER) {
                    throw new StorageException(MESSAGE_INVALID_REQUEST, CODE_INVALID_REQUEST);
                }
                values[index] = integer;
            } else if (value instanceof Double) {
                double number = (Double) value;
                if (Double.isNaN(number) || Double.isInfinite(number)) {
                    throw new StorageException(MESSAGE_INVALID_REQUEST, CODE_INVALID_REQUEST);
                }
                if (number == Math.rint(number) && Math.abs(number) > MAX_SAFE_INTEGER) {
                    throw new StorageException(MESSAGE_INVALID_REQUEST, CODE_INVALID_REQUEST);
                }
                values[index] = number;
            } else if (value instanceof String) {
                values[index] = value;
            } else {
                throw new StorageException(MESSAGE_INVALID_REQUEST, CODE_INVALID_REQUEST);
            }
        }
        return values;
    }

    /**
     * `executeUpdateDelete` returns the row id for INSERT, not a row count, so
     * inserts are executed through `executeInsert` and reported as 0 or 1
     * changed rows ("insert or ignore" that did nothing reports 0).
     */
    private static long execute(SQLiteDatabase database, String sql, Object[] bound)
            throws StorageException {
        String head = sql.trim().toLowerCase(Locale.ROOT);
        SQLiteStatement statement;
        try {
            statement = database.compileStatement(sql);
        } catch (RuntimeException failure) {
            throw new StorageException(MESSAGE_FAILED, CODE_FAILED);
        }
        try {
            for (int index = 0; index < bound.length; index++) {
                bind(statement, index + 1, bound[index]);
            }
            if (head.startsWith("insert") || head.startsWith("replace")) {
                return statement.executeInsert() == -1L ? 0L : 1L;
            }
            if (head.startsWith("update") || head.startsWith("delete")) {
                return Math.max(0L, statement.executeUpdateDelete());
            }
            statement.execute();
            return 0L;
        } catch (RuntimeException failure) {
            throw new StorageException(MESSAGE_FAILED, CODE_FAILED);
        } finally {
            statement.close();
        }
    }

    private static void bind(SQLiteStatement statement, int index, Object value) {
        if (value == null) {
            statement.bindNull(index);
        } else if (value instanceof Long) {
            statement.bindLong(index, (Long) value);
        } else if (value instanceof Double) {
            statement.bindDouble(index, (Double) value);
        } else {
            statement.bindString(index, (String) value);
        }
    }

    private static void readRows(Cursor cursor, JSArray rows) throws StorageException {
        String[] columns = cursor.getColumnNames();
        while (cursor.moveToNext()) {
            JSObject row = new JSObject();
            for (int index = 0; index < columns.length; index++) {
                switch (cursor.getType(index)) {
                    case Cursor.FIELD_TYPE_NULL:
                        row.put(columns[index], JSONObject.NULL);
                        break;
                    case Cursor.FIELD_TYPE_INTEGER: {
                        long value = cursor.getLong(index);
                        // JavaScript cannot represent this exactly; reject instead
                        // of storing a rounded value.
                        if (value > MAX_SAFE_INTEGER || value < -MAX_SAFE_INTEGER) {
                            throw new StorageException(MESSAGE_FAILED, CODE_FAILED);
                        }
                        row.put(columns[index], value);
                        break;
                    }
                    case Cursor.FIELD_TYPE_FLOAT: {
                        double value = cursor.getDouble(index);
                        if (Double.isNaN(value) || Double.isInfinite(value)) {
                            throw new StorageException(MESSAGE_FAILED, CODE_FAILED);
                        }
                        row.put(columns[index], value);
                        break;
                    }
                    case Cursor.FIELD_TYPE_STRING:
                        row.put(columns[index], cursor.getString(index));
                        break;
                    default:
                        // The messaging schema has no BLOB columns.
                        throw new StorageException(MESSAGE_FAILED, CODE_FAILED);
                }
            }
            rows.put(row);
        }
    }
}
