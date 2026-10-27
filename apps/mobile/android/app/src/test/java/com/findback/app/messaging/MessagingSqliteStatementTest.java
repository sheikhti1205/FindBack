package com.findback.app.messaging;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertThrows;

import java.lang.invoke.MethodHandles;
import java.lang.invoke.MethodType;
import com.getcapacitor.JSArray;
import org.json.JSONObject;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import java.lang.reflect.Field;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.Map;
import org.junit.Test;

/** Runs the actual native validator; no Android database/runtime claim. */
public class MessagingSqliteStatementTest {
    private static final class RecordedCall extends PluginCall {
        String rejectedCode;
        final CountDownLatch rejected = new CountDownLatch(1);
        RecordedCall(String account) {
            super(null, "FindbackMessagingSqlite", "test", "open", new JSObject().put("accountId", account));
        }
        @Override public void reject(String message, String code) { rejectedCode = code; rejected.countDown(); }
    }

    @Test public void unexpectedFailureBeforeConnectionDoesNotStrandAccountAcrossRecreation() throws Exception {
        String account = "00000000-0000-4000-8000-0000000000c3";
        FindbackMessagingSqlitePlugin first = new FindbackMessagingSqlitePlugin() {
            @Override DatabaseConnection openDatabase(String ignored) {
                throw new SecurityException("private directory unavailable");
            }
        };
        FindbackMessagingSqlitePlugin replacement = new FindbackMessagingSqlitePlugin() {
            @Override DatabaseConnection openDatabase(String ignored) {
                throw new SecurityException("private directory unavailable");
            }
        };
        try {
            RecordedCall failed = new RecordedCall(account);
            first.open(failed);
            org.junit.Assert.assertTrue(failed.rejected.await(2, TimeUnit.SECONDS));
            assertEquals("MESSAGING_STORAGE_FAILED", failed.rejectedCode);
            first.handleOnDestroy();
            RecordedCall retry = new RecordedCall(account);
            replacement.open(retry);
            org.junit.Assert.assertTrue(retry.rejected.await(2, TimeUnit.SECONDS));
            assertEquals("MESSAGING_STORAGE_FAILED", retry.rejectedCode);
        } finally {
            first.handleOnDestroy();
            replacement.handleOnDestroy();
        }
    }

    @Test public void duplicatePendingOpenIsRejectedBeforeTheNativeLaneAndAcrossPluginInstances() throws Exception {
        FindbackMessagingSqlitePlugin first = new FindbackMessagingSqlitePlugin();
        FindbackMessagingSqlitePlugin second = new FindbackMessagingSqlitePlugin();
        Field field = FindbackMessagingSqlitePlugin.class.getDeclaredField("lane");
        field.setAccessible(true);
        ExecutorService lane = (ExecutorService) field.get(first);
        CountDownLatch entered = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        lane.execute(() -> {
            entered.countDown();
            try { release.await(); } catch (InterruptedException failure) { Thread.currentThread().interrupt(); }
        });
        try {
            org.junit.Assert.assertTrue(entered.await(2, TimeUnit.SECONDS));
            String account = "00000000-0000-4000-8000-0000000000c1";
            first.open(new RecordedCall(account));
            RecordedCall duplicate = new RecordedCall(account);
            first.open(duplicate);
            assertEquals("MESSAGING_STORAGE_ALREADY_OPEN", duplicate.rejectedCode);
            RecordedCall recreated = new RecordedCall(account);
            second.open(recreated);
            assertEquals("MESSAGING_STORAGE_ALREADY_OPEN", recreated.rejectedCode);
        } finally {
            first.handleOnDestroy();
            second.handleOnDestroy();
            release.countDown();
            org.junit.Assert.assertTrue(lane.awaitTermination(2, TimeUnit.SECONDS));
            org.junit.Assert.assertTrue(((ExecutorService) field.get(second)).awaitTermination(2, TimeUnit.SECONDS));
            Field owners = FindbackMessagingSqlitePlugin.class.getDeclaredField("accountOwners");
            owners.setAccessible(true);
            org.junit.Assert.assertFalse(((Map<?, ?>) owners.get(null))
                    .containsKey("00000000-0000-4000-8000-0000000000c1"));
        }
    }

    @Test public void destroyedPluginDoesNotReserveAnAccount() throws Exception {
        FindbackMessagingSqlitePlugin plugin = new FindbackMessagingSqlitePlugin();
        plugin.handleOnDestroy();
        String account = "00000000-0000-4000-8000-0000000000c2";
        RecordedCall call = new RecordedCall(account);
        plugin.open(call);
        assertEquals("MESSAGING_STORAGE_CLOSED", call.rejectedCode);
        Field owners = FindbackMessagingSqlitePlugin.class.getDeclaredField("accountOwners");
        owners.setAccessible(true);
        org.junit.Assert.assertFalse(((Map<?, ?>) owners.get(null)).containsKey(account));
        Field field = FindbackMessagingSqlitePlugin.class.getDeclaredField("lane");
        field.setAccessible(true);
        org.junit.Assert.assertTrue(((ExecutorService) field.get(plugin)).awaitTermination(2, TimeUnit.SECONDS));
    }

    private static String validate(String sql) throws Exception {
        try {
            return (String) MethodHandles.privateLookupIn(FindbackMessagingSqlitePlugin.class,
                    MethodHandles.lookup()).findStatic(FindbackMessagingSqlitePlugin.class,
                    "validateStatement", MethodType.methodType(String.class, String.class)).invokeExact(sql);
        } catch (Exception failure) {
            throw failure;
        } catch (Throwable failure) {
            throw new AssertionError(failure);
        }
    }

    private static void rejects(String sql) {
        Exception failure = assertThrows(Exception.class, () -> validate(sql));
        assertEquals("Messaging storage rejected an invalid request.", failure.getMessage());
    }

    @Test public void refusesCommentPrefixedDurabilityChanges() {
        rejects("/* adapter */ pragma synchronous = off");
        rejects("-- adapter\npragma foreign_keys = off");
        rejects("/* adapter */ pragma writable_schema = on");
    }

    @Test public void refusesCommentsInsideSqlTokens() {
        rejects("pragma/**/synchronous = off");
        rejects("pragma /* boundary */ journal_mode = delete");
        rejects("select 1 /* trailing comment */");
    }

    @Test public void refusesByteOrderMarkBeforePragma() {
        rejects("\uFEFFpragma synchronous = off");
    }

    @Test public void acceptsOnlyDurablePragmas() throws Exception {
        for (String sql : new String[] {"pragma journal_mode = wal", "pragma synchronous = full",
                "pragma foreign_keys = on", "pragma busy_timeout = 5000", "pragma journal_mode",
                "pragma synchronous", "pragma foreign_keys"}) {
            assertEquals(sql, validate(sql));
        }
        rejects("pragma synchronous = off");
        rejects("pragma foreign_keys = off");
        rejects("pragma writable_schema = on");
        rejects("pragma main.synchronous = off");
        rejects("pragma \"synchronous\" = off");
    }

    @Test public void forbidsOtherFilesAndMultipleStatements() {
        rejects("attach database ? as other");
        rejects("detach database other");
        rejects("vacuum into ?");
        rejects("select load_extension(?)");
        rejects("select 1; pragma synchronous = off");
        rejects("select 1;;");
        rejects("select 'unclosed");
    }

    @Test public void literalMessageContentIsNotSqlSyntax() throws Exception {
        String sql = "select 'don''t attach; -- or /* interpret */ message text'";
        assertEquals(sql, validate(sql));
        assertNotNull(validate("insert into messages (body) values (?)"));
    }

    private static Object[] arguments(JSArray values) throws Throwable {
        return (Object[]) MethodHandles.privateLookupIn(FindbackMessagingSqlitePlugin.class,
                MethodHandles.lookup()).findStatic(FindbackMessagingSqlitePlugin.class,
                "readArguments", MethodType.methodType(Object[].class, JSArray.class)).invokeExact(values);
    }

    @Test public void nativeArgumentsPreserveNullNumbersAndStrings() throws Throwable {
        JSArray values = new JSArray();
        values.put(JSONObject.NULL).put(0).put(-1).put(2.5).put(1_700_000_000_000L).put("");
        assertArrayEquals(new Object[] {null, 0L, -1L, 2.5, 1_700_000_000_000L, ""}, arguments(values));
    }

    @Test public void nativeArgumentsRejectUnsafeIntegerEvenWhenJsonParsesAsDouble() {
        JSArray values = new JSArray();
        values.put(9_007_199_254_740_992.0);
        Throwable failure = assertThrows(Throwable.class, () -> arguments(values));
        assertEquals("Messaging storage rejected an invalid request.", failure.getMessage());
    }
}
