package com.findback.app.vlm

import com.google.gson.JsonParser
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.io.RandomAccessFile
import java.security.DigestInputStream
import java.security.MessageDigest
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream

/**
 * Streaming `.fbmodel` package host: the Android half of the
 * `NativePackageHost` seam declared in `modelTransfers.ts`.
 *
 * Import: SAF content URI stream -> staging file with an incremental
 * whole-package SHA-256 -> ZIP central-directory iteration -> safe-path
 * validation -> expanded-size limits -> per-entry incremental hash ->
 * temp sandbox -> atomic promote. Export: installed files ->
 * [ZipOutputStream] -> SAF destination stream.
 *
 * Buffers are fixed-size (64 KiB); no entry is ever buffered whole in RAM.
 * Rejections mirror the transfer failure codes in `modelTransfers.ts`:
 * `../`, absolute paths, symlinks, executable magic, undeclared files,
 * hash/ID mismatch, insufficient storage, oversized expansion, and
 * corrupt/truncated archives all abort with nothing installed.
 *
 * This file has no Android framework dependencies (plain `java.io` /
 * `java.util.zip` plus Gson, already used by [ModelStore]) so the
 * validation logic runs as JVM unit tests. The thin SAF wiring
 * (`ContentResolver` streams, free-space reading) lives in the
 * `LocalVlmPlugin` bridge methods.
 */
object PackageHost {

    const val MANIFEST_NAME = "manifest.json"
    const val CHECKSUMS_NAME = "checksums.json"
    const val PACKAGE_VERSION = "1"

    /** Absolute expanded-size cap for one imported/exported package (2 GiB). */
    const val MAX_EXPANDED_BYTES = 2L * 1024L * 1024L * 1024L

    /** Upper bound for the manifest document itself (small by construction). */
    const val MAX_MANIFEST_BYTES = 256 * 1024

    private const val IO_BUFFER_SIZE = 64 * 1024

    /** Data-only invariant: suffixes that must never appear in a package. */
    val DENIED_SUFFIXES: List<String> = listOf(
        ".so", ".dll", ".dylib", ".dex", ".odex", ".apk", ".aab",
        ".exe", ".msi", ".sh", ".bat", ".cmd", ".py"
    )

    /** Failure codes; wire-compatible with the TS transfer failure codes. */
    object Code {
        const val MISSING_PIN = "MISSING_PIN"
        const val MANIFEST_MISSING = "MANIFEST_MISSING"
        const val MANIFEST_INVALID = "MANIFEST_INVALID"
        const val ENTRY_MISMATCH = "ENTRY_MISMATCH"
        const val MISSING_FILE = "MISSING_FILE"
        const val EXTRA_FILE = "EXTRA_FILE"
        const val UNSAFE_PATH = "UNSAFE_PATH"
        const val DENIED_FILE = "DENIED_FILE"
        const val SIZE_MISMATCH = "SIZE_MISMATCH"
        const val HASH_MISMATCH = "HASH_MISMATCH"
        const val WHOLE_HASH_MISMATCH = "WHOLE_HASH_MISMATCH"
        const val PACKAGE_TOO_LARGE = "PACKAGE_TOO_LARGE"
        const val INSUFFICIENT_STORAGE = "INSUFFICIENT_STORAGE"
        const val MISSING_WEIGHTS = "MISSING_WEIGHTS"
        const val NO_FILES = "NO_FILES"
        const val CORRUPT_ARCHIVE = "CORRUPT_ARCHIVE"
    }

    data class ManifestFile(
        val path: String,
        val bytes: Long,
        val sha256: String,
        val method: String
    )

    data class Manifest(
        val packageVersion: String,
        val entryId: String,
        val upstreamRepo: String,
        val upstreamRev: String,
        val upstreamFile: String,
        val createdAt: String,
        val files: List<ManifestFile>
    )

    data class ImportResult(
        val ok: Boolean,
        val code: String? = null,
        val reason: String? = null,
        val manifest: Manifest? = null
    )

    data class ExportResult(
        val ok: Boolean,
        val code: String? = null,
        val reason: String? = null,
        val manifest: Manifest? = null,
        val checksumsJson: String? = null
    )

    /**
     * Why an interior path is unsafe, or null when it is confined to the
     * per-model sandbox. Rejects empty paths, absolute paths,
     * drive-letter paths, `..` segments (either separator), backslashes,
     * and empty segments.
     */
    fun findUnsafePathReason(path: String): String? {
        if (path.isEmpty()) return "empty interior path"
        if (path.startsWith("/") || path.startsWith("\\")) return "absolute path: $path"
        if (path.length >= 2 && path[1] == ':' && path[0].isLetter()) return "drive-letter path: $path"
        if (path.contains("\\")) return "backslash separator: $path"
        val segments = path.split("/")
        if (segments.any { it == ".." }) return "parent traversal: $path"
        if (segments.any { it.isEmpty() }) return "empty segment: $path"
        return null
    }

    fun isDeniedSuffix(interiorPath: String): Boolean {
        val lower = interiorPath.lowercase()
        return DENIED_SUFFIXES.any { lower.endsWith(it) }
    }

    /**
     * True when the leading bytes match a denied executable magic
     * (ELF, MZ, dex, Mach-O fat/32/64 in either endianness).
     */
    fun hasDeniedMagic(head: ByteArray, length: Int): Boolean {
        val n = minOf(head.size, length)
        if (n >= 4 &&
            head[0] == 0x7f.toByte() && head[1] == 0x45.toByte() &&
            head[2] == 0x4c.toByte() && head[3] == 0x46.toByte()
        ) return true
        if (n >= 2 && head[0] == 0x4d.toByte() && head[1] == 0x5a.toByte()) return true
        if (n >= 4 &&
            head[0] == 0x64.toByte() && head[1] == 0x65.toByte() &&
            head[2] == 0x78.toByte() && head[3] == 0x0a.toByte()
        ) return true
        if (n >= 4) {
            val magic = ((head[0].toInt() and 0xff) shl 24) or
                ((head[1].toInt() and 0xff) shl 16) or
                ((head[2].toInt() and 0xff) shl 8) or
                (head[3].toInt() and 0xff)
            if (magic == 0xCAFEBABE.toInt() || magic == 0xFEEDFACE.toInt() ||
                magic == 0xFEEDFACF.toInt() || magic == 0xCEFAEDFE.toInt() ||
                magic == 0xCFFAEDFE.toInt()
            ) return true
        }
        return false
    }

    fun sha256Hex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256")
        return digest.digest(bytes).joinToString("") { "%02x".format(it) }
    }

    private fun fail(code: String, reason: String) = ImportResult(false, code, reason)

    private fun parseManifest(raw: ByteArray): Manifest? {
        val root = try {
            JsonParser.parseString(raw.toString(Charsets.UTF_8))
        } catch (_: Exception) {
            return null
        }
        if (!root.isJsonObject) return null
        val obj = root.asJsonObject
        if (!obj.has("packageVersion") || obj.get("packageVersion").asString != PACKAGE_VERSION) return null
        if (!obj.has("entryId") || !obj.get("entryId").isJsonPrimitive) return null
        if (!obj.has("upstream") || !obj.get("upstream").isJsonObject) return null
        val upstream = obj.getAsJsonObject("upstream")
        if (!upstream.has("repo") || !upstream.has("rev") || !upstream.has("file")) return null
        if (!obj.has("createdAt") || !obj.get("createdAt").isJsonPrimitive) return null
        if (!obj.has("files") || !obj.get("files").isJsonArray) return null
        val filesJson = obj.getAsJsonArray("files")
        if (filesJson.size() == 0) return null
        val files = mutableListOf<ManifestFile>()
        for (element in filesJson) {
            if (!element.isJsonObject) return null
            val file = element.asJsonObject
            if (!file.has("path") || !file.has("bytes") || !file.has("sha256") || !file.has("method")) return null
            val method = try {
                file.get("method").asString
            } catch (_: Exception) {
                return null
            }
            if (method != "STORE" && method != "DEFLATE") return null
            val bytes = try {
                file.get("bytes").asLong
            } catch (_: Exception) {
                return null
            }
            if (bytes < 0) return null
            files.add(
                ManifestFile(
                    path = file.get("path").asString,
                    bytes = bytes,
                    sha256 = file.get("sha256").asString,
                    method = method
                )
            )
        }
        return Manifest(
            packageVersion = PACKAGE_VERSION,
            entryId = obj.get("entryId").asString,
            upstreamRepo = upstream.get("repo").asString,
            upstreamRev = upstream.get("rev").asString,
            upstreamFile = upstream.get("file").asString,
            createdAt = obj.get("createdAt").asString,
            files = files
        )
    }

    private fun manifestJson(manifest: Manifest): String {
        val sb = StringBuilder()
        sb.append("{\n")
        sb.append("  \"packageVersion\": \"${manifest.packageVersion}\",\n")
        sb.append("  \"entryId\": \"${manifest.entryId}\",\n")
        sb.append("  \"upstream\": {\"repo\": \"${manifest.upstreamRepo}\", " +
            "\"rev\": \"${manifest.upstreamRev}\", \"file\": \"${manifest.upstreamFile}\"},\n")
        sb.append("  \"createdAt\": \"${manifest.createdAt}\",\n")
        sb.append("  \"files\": [\n")
        manifest.files.forEachIndexed { index, file ->
            sb.append("    {\"path\": \"${file.path}\", \"bytes\": ${file.bytes}, " +
                "\"sha256\": \"${file.sha256}\", \"method\": \"${file.method}\"}")
            if (index < manifest.files.size - 1) sb.append(",")
            sb.append("\n")
        }
        sb.append("  ]\n}")
        return sb.toString()
    }

    // Central-directory layout (little-endian).
    private const val END_SIG = 0x06054b50
    private const val CENTRAL_SIG = 0x02014b50
    private const val S_IFMT = 0xF000
    private const val S_IFLNK = 0xA000

    private fun readU16LE(data: ByteArray, offset: Int): Int =
        (data[offset].toInt() and 0xff) or ((data[offset + 1].toInt() and 0xff) shl 8)

    private fun readU32LE(data: ByteArray, offset: Int): Long =
        (data[offset].toLong() and 0xff) or
            ((data[offset + 1].toLong() and 0xff) shl 8) or
            ((data[offset + 2].toLong() and 0xff) shl 16) or
            ((data[offset + 3].toLong() and 0xff) shl 24)

    /**
     * Names in the ZIP central directory carrying the symlink file-type
     * bits, or null when the central directory cannot be parsed.
     * `java.util.zip` never creates symlinks on extraction, but the bit is
     * still a rejection signal per the data-only invariant.
     */
    fun centralDirSymlinkNames(staged: File): Set<String>? {
        return try {
            RandomAccessFile(staged, "r").use { raf ->
                val length = raf.length()
                if (length < 22) return null
                val searchSize = minOf(length, 22L + 65535L).toInt()
                val tail = ByteArray(searchSize)
                raf.seek(length - searchSize)
                raf.readFully(tail)
                var endOffset = -1L
                var i = tail.size - 22
                while (i >= 0) {
                    if (readU32LE(tail, i) == END_SIG.toLong()) {
                        endOffset = length - searchSize + i
                        break
                    }
                    i--
                }
                if (endOffset < 0) return null
                val end = ByteArray(22)
                raf.seek(endOffset)
                raf.readFully(end)
                val centralCount = readU16LE(end, 10)
                val centralSize = readU32LE(end, 12)
                val centralOffset = readU32LE(end, 16)
                if (centralSize > length || centralOffset + centralSize > length) return null
                val central = ByteArray(centralSize.toInt())
                raf.seek(centralOffset)
                raf.readFully(central)
                val symlinks = mutableSetOf<String>()
                var pos = 0
                repeat(centralCount) {
                    if (pos + 46 > central.size) return null
                    if (readU32LE(central, pos) != CENTRAL_SIG.toLong()) return null
                    val nameLen = readU16LE(central, pos + 28)
                    val extraLen = readU16LE(central, pos + 30)
                    val commentLen = readU16LE(central, pos + 32)
                    val externalAttrs = readU32LE(central, pos + 38)
                    if (pos + 46 + nameLen + extraLen + commentLen > central.size) return null
                    val name = central.copyOfRange(pos + 46, pos + 46 + nameLen).toString(Charsets.UTF_8)
                    val unixMode = (externalAttrs shr 16).toInt()
                    if (unixMode and S_IFMT == S_IFLNK) symlinks.add(name)
                    pos += 46 + nameLen + extraLen + commentLen
                }
                symlinks
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun deleteRecursively(file: File) {
        if (file.isDirectory) {
            file.listFiles()?.forEach { deleteRecursively(it) }
        }
        file.delete()
    }

    /**
     * Validates a `.fbmodel` package from [source] against the catalogue
     * entry [entryId] whose shipped pin is [expectedSha256] (from the
     * in-app catalogue — never from inside the package under test).
     *
     * The stream is staged to [workDir] with an incremental whole-package
     * hash, entries are extracted to a temp sandbox under [workDir], and on
     * full success the sandbox is atomically promoted to
     * `[installRoot]/[entryId]`. Any failure discards the sandbox and
     * staging file with nothing installed.
     *
     * @param freeBytes passively observed free bytes, or null when unknown.
     * @param maxExpandedBytes test override for the expanded-size cap.
     */
    fun importPackage(
        source: InputStream,
        entryId: String,
        expectedSha256: String,
        workDir: File,
        installRoot: File,
        freeBytes: Long? = null,
        maxExpandedBytes: Long = MAX_EXPANDED_BYTES
    ): ImportResult {
        if (entryId.isBlank()) return fail(Code.ENTRY_MISMATCH, "Import refused: empty catalogue entry id.")
        if (expectedSha256.isBlank()) {
            return fail(Code.MISSING_PIN, "No shipped hash pin: the package cannot be verified, so import is refused.")
        }
        workDir.mkdirs()
        val nonce = System.nanoTime()
        val staging = File(workDir, "package-$nonce.tmp")
        val sandbox = File(workDir, "sandbox-$nonce")
        try {
            val wholeDigest = MessageDigest.getInstance("SHA-256")
            try {
                DigestInputStream(source, wholeDigest).use { digestIn ->
                    FileOutputStream(staging).use { out ->
                        val buffer = ByteArray(IO_BUFFER_SIZE)
                        while (true) {
                            val read = digestIn.read(buffer)
                            if (read == -1) break
                            out.write(buffer, 0, read)
                        }
                    }
                }
            } catch (_: Exception) {
                return fail(Code.CORRUPT_ARCHIVE, "Package file could not be read. Nothing installed.")
            }
            val wholeHex = wholeDigest.digest().joinToString("") { "%02x".format(it) }
            if (!wholeHex.equals(expectedSha256, ignoreCase = true)) {
                return fail(
                    Code.WHOLE_HASH_MISMATCH,
                    "Whole-package hash does not match the shipped catalogue pin. Nothing installed."
                )
            }

            val zip = try {
                ZipFile(staging)
            } catch (_: Exception) {
                return fail(Code.CORRUPT_ARCHIVE, "Package container is unreadable: not a valid ZIP archive.")
            }
            zip.use { archive ->
                val symlinkNames = centralDirSymlinkNames(staging)
                    ?: return fail(Code.CORRUPT_ARCHIVE, "Package container is unreadable: central directory cannot be parsed.")
                val fileEntries = archive.entries().asSequence().toList()
                val manifestZipEntry = fileEntries.singleOrNull { it.name == MANIFEST_NAME && !it.isDirectory }
                if (manifestZipEntry == null) {
                    return fail(Code.MANIFEST_MISSING, "Package has no manifest.json.")
                }
                if (symlinkNames.contains(MANIFEST_NAME)) {
                    return fail(Code.UNSAFE_PATH, "Symlink entry rejected: manifest.json.")
                }
                val manifestRaw = try {
                    readBounded(archive.getInputStream(manifestZipEntry), MAX_MANIFEST_BYTES)
                } catch (_: Exception) {
                    return fail(
                        Code.CORRUPT_ARCHIVE,
                        "Package container is unreadable: the manifest entry cannot be opened."
                    )
                }
                if (manifestRaw == null) {
                    return fail(Code.MANIFEST_INVALID, "manifest.json exceeds the manifest size bound.")
                }
                val manifest = parseManifest(manifestRaw)
                    ?: return fail(Code.MANIFEST_INVALID, "manifest.json is malformed or not package schema v1.")
                if (manifest.entryId != entryId) {
                    return fail(
                        Code.ENTRY_MISMATCH,
                        "Package entry ${manifest.entryId} does not match catalogue entry $entryId."
                    )
                }
                for (file in manifest.files) {
                    val unsafe = findUnsafePathReason(file.path)
                    if (unsafe != null) return fail(Code.UNSAFE_PATH, "Manifest lists an unsafe path: $unsafe.")
                    if (isDeniedSuffix(file.path)) {
                        return fail(Code.DENIED_FILE, "Package lists a denied executable path: ${file.path}.")
                    }
                }
                val byName = fileEntries.filter { !it.isDirectory }.associateBy { it.name }
                for (listed in manifest.files) {
                    val present = byName[listed.path]
                        ?: return fail(Code.MISSING_FILE, "Manifest-listed file missing: ${listed.path}.")
                    if (symlinkNames.contains(listed.path)) {
                        return fail(Code.UNSAFE_PATH, "Symlink entry rejected: ${listed.path}.")
                    }
                    if (present.isDirectory) {
                        return fail(Code.MISSING_FILE, "Manifest-listed file missing: ${listed.path}.")
                    }
                }
                val manifestPaths = manifest.files.map { it.path }.toSet()
                for (candidate in fileEntries) {
                    val name = candidate.name
                    if (name == MANIFEST_NAME) continue
                    if (candidate.isDirectory) {
                        val unsafe = findUnsafePathReason(name.trimEnd('/'))
                        if (unsafe != null) return fail(Code.UNSAFE_PATH, "Unsafe interior path: $unsafe.")
                        continue
                    }
                    if (symlinkNames.contains(name)) {
                        return fail(Code.UNSAFE_PATH, "Symlink entry rejected: $name.")
                    }
                    val unsafe = findUnsafePathReason(name)
                    if (unsafe != null) return fail(Code.UNSAFE_PATH, "Unsafe interior path: $unsafe.")
                    if (!manifestPaths.contains(name)) {
                        return fail(Code.EXTRA_FILE, "Unlisted interior file rejected: $name.")
                    }
                }

                val declaredTotal = manifest.files.sumOf { it.bytes }
                if (declaredTotal > maxExpandedBytes) {
                    return fail(
                        Code.PACKAGE_TOO_LARGE,
                        "Declared package size $declaredTotal bytes exceeds the $maxExpandedBytes-byte cap."
                    )
                }
                if (freeBytes != null && declaredTotal > freeBytes) {
                    return fail(
                        Code.INSUFFICIENT_STORAGE,
                        "Not enough free storage: the install needs $declaredTotal bytes but only $freeBytes are free. Nothing installed."
                    )
                }

                sandbox.mkdirs()
                val sandboxCanonical = sandbox.canonicalPath
                var expandedTotal = 0L
                for (file in manifest.files) {
                    val zipEntry = byName[file.path]
                        ?: return fail(Code.MISSING_FILE, "Manifest-listed file missing: ${file.path}.")
                    val target = File(sandbox, file.path)
                    if (!target.canonicalPath.startsWith(sandboxCanonical + File.separator)) {
                        return fail(Code.UNSAFE_PATH, "Unsafe interior path: ${file.path} escapes the sandbox.")
                    }
                    target.parentFile?.mkdirs()
                    val fileDigest = MessageDigest.getInstance("SHA-256")
                    val head = ByteArray(4)
                    var headFilled = 0
                    var actualBytes = 0L
                    try {
                        archive.getInputStream(zipEntry).use { input ->
                            FileOutputStream(target).use { out ->
                                val buffer = ByteArray(IO_BUFFER_SIZE)
                                while (true) {
                                    val read = input.read(buffer)
                                    if (read == -1) break
                                    actualBytes += read
                                    if (actualBytes > file.bytes) {
                                        return fail(
                                            Code.SIZE_MISMATCH,
                                            "Declared-vs-actual size mismatch for ${file.path}: exceeds manifest-declared ${file.bytes} bytes."
                                        )
                                    }
                                    expandedTotal += read
                                    if (expandedTotal > maxExpandedBytes) {
                                        return fail(
                                            Code.PACKAGE_TOO_LARGE,
                                            "Expanded package size exceeds the $maxExpandedBytes-byte cap."
                                        )
                                    }
                                    fileDigest.update(buffer, 0, read)
                                    if (headFilled < 4) {
                                        val copyCount = minOf(4 - headFilled, read)
                                        System.arraycopy(buffer, 0, head, headFilled, copyCount)
                                        headFilled += copyCount
                                    }
                                    out.write(buffer, 0, read)
                                }
                            }
                        }
                    } catch (_: Exception) {
                        return fail(
                            Code.CORRUPT_ARCHIVE,
                            "Package container is unreadable: interior entry ${file.path} cannot be streamed (truncated or corrupted container). Nothing installed."
                        )
                    }
                    if (actualBytes != file.bytes) {
                        return fail(
                            Code.SIZE_MISMATCH,
                            "Declared-vs-actual size mismatch for ${file.path}: manifest says ${file.bytes}, read $actualBytes."
                        )
                    }
                    if (hasDeniedMagic(head, headFilled)) {
                        return fail(Code.DENIED_FILE, "Executable content rejected: ${file.path}.")
                    }
                    val fileHex = fileDigest.digest().joinToString("") { "%02x".format(it) }
                    if (!fileHex.equals(file.sha256, ignoreCase = true)) {
                        return fail(
                            Code.HASH_MISMATCH,
                            "Checksum mismatch for ${file.path}: does not match the manifest pin."
                        )
                    }
                }

                installRoot.mkdirs()
                val installDir = File(installRoot, entryId)
                try {
                    moveDirTo(sandbox, installDir)
                } catch (e: Exception) {
                    return fail(
                        Code.CORRUPT_ARCHIVE,
                        "Install could not be completed: ${e.message}. Nothing installed."
                    )
                }
                return ImportResult(true, manifest = manifest)
            }
        } finally {
            staging.delete()
            // After a successful promote the sandbox path no longer exists
            // (it was moved); anything still present is a leftover to clean.
            if (sandbox.exists()) {
                deleteRecursively(sandbox)
            }
        }
    }

    private fun moveDirTo(source: File, dest: File) {
        if (dest.exists()) deleteRecursively(dest)
        dest.parentFile?.mkdirs()
        try {
            java.nio.file.Files.move(
                source.toPath(),
                dest.toPath(),
                java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                java.nio.file.StandardCopyOption.ATOMIC_MOVE
            )
        } catch (_: java.nio.file.AtomicMoveNotSupportedException) {
            java.nio.file.Files.move(
                source.toPath(),
                dest.toPath(),
                java.nio.file.StandardCopyOption.REPLACE_EXISTING
            )
        }
    }

    private fun readBounded(input: InputStream, cap: Int): ByteArray? {
        input.use { stream ->
            val out = java.io.ByteArrayOutputStream()
            val buffer = ByteArray(IO_BUFFER_SIZE)
            var total = 0
            while (true) {
                val read = stream.read(buffer)
                if (read == -1) break
                total += read
                if (total > cap) return null
                out.write(buffer, 0, read)
            }
            return out.toByteArray()
        }
    }

    private fun compressionMethodFor(path: String): String =
        if (path.startsWith("weights/") || path.startsWith("projector/")) "STORE" else "DEFLATE"

    /**
     * Package-schema v1 interior path for an installed relative path.
     * Authoritative runtime files are stored flat (`ModelFileSpec.path`
     * with no directory) while the package carries the runtime artifact
     * under `weights/`; already-nested interiors (including
     * `tokenizer/` and `projector/`) pass through unchanged.
     */
    private fun exportInteriorPath(relative: String): String =
        if (!relative.contains('/') && relative.endsWith(".litertlm")) "weights/$relative" else relative

    /**
     * Packages the installed files for [entryId] from [installDir] into a
     * shareable offline `.fbmodel` written to [dest], streaming every file
     * with bounded buffers. Applies the import-side validation up front so
     * only data-only packages can be produced; requires at least one
     * `weights/` runtime artifact. Flat installed runtime files
     * (`ModelFileSpec.path` with no directory) are mapped to
     * `weights/<path>` on export only; the flat store layout is unchanged
     * and already-nested interiors pass through. Returns the manifest +
     * checksums — the file bytes live with the destination, never in the
     * result.
     */
    fun exportPackage(
        entryId: String,
        installDir: File,
        dest: OutputStream,
        createdAt: String = java.time.Instant.now().toString(),
        maxExpandedBytes: Long = MAX_EXPANDED_BYTES
    ): ExportResult {
        fun exportFail(code: String, reason: String) = ExportResult(false, code, reason)
        if (entryId.isBlank()) return exportFail(Code.ENTRY_MISMATCH, "Export refused: empty catalogue entry id.")
        if (!installDir.isDirectory) return exportFail(Code.NO_FILES, "Nothing to package: no installed files supplied.")
        val baseCanonical = try {
            installDir.canonicalPath
        } catch (_: Exception) {
            return exportFail(Code.CORRUPT_ARCHIVE, "Installed files could not be read. Nothing written.")
        }
        val regularFiles = installDir.walkTopDown()
            .filter { it.isFile }
            .map { it.canonicalPath.removePrefix(baseCanonical + File.separator).replace(File.separatorChar, '/') to it }
            .sortedBy { it.first }
            .toList()
        if (regularFiles.isEmpty()) return exportFail(Code.NO_FILES, "Nothing to package: no installed files supplied.")
        val exportEntries = regularFiles.map { (relative, file) -> exportInteriorPath(relative) to file }
        if (exportEntries.none { it.first.startsWith("weights/") }) {
            return exportFail(Code.MISSING_WEIGHTS, "Package requires at least one weights/ runtime artifact.")
        }
        for ((interior, _) in exportEntries) {
            val unsafe = findUnsafePathReason(interior)
            if (unsafe != null) return exportFail(Code.UNSAFE_PATH, "Unsafe installed path: $unsafe.")
            if (isDeniedSuffix(interior)) return exportFail(Code.DENIED_FILE, "Executable content rejected: $interior.")
        }

        data class Observed(val path: String, val bytes: Long, val sha256: String, val method: String)

        val observed = mutableListOf<Observed>()
        var expandedTotal = 0L
        try {
            ZipOutputStream(dest).use { zip ->
                for ((interior, file) in exportEntries) {
                    val method = compressionMethodFor(interior)
                    val declaredSize = file.length()
                    val fileDigest = MessageDigest.getInstance("SHA-256")
                    val head = ByteArray(4)
                    var headFilled = 0
                    var observedBytes = 0L
                    val zipEntry = ZipEntry(interior)
                    if (method == "STORE") {
                        // STORED entries need size + CRC up front: stream one
                        // pass for the CRC, then stream again for the bytes.
                        // Both passes use bounded buffers — no full-file RAM.
                        val crc = CRC32()
                        try {
                            FileInputStream(file).use { input ->
                                val buffer = ByteArray(IO_BUFFER_SIZE)
                                while (true) {
                                    val read = input.read(buffer)
                                    if (read == -1) break
                                    crc.update(buffer, 0, read)
                                }
                            }
                        } catch (_: Exception) {
                            return exportFail(
                                Code.CORRUPT_ARCHIVE,
                                "Export interrupted for $interior: the installed file cannot be read. Partial output discarded."
                            )
                        }
                        zipEntry.method = ZipEntry.STORED
                        zipEntry.size = declaredSize
                        zipEntry.crc = crc.value
                    } else {
                        zipEntry.method = ZipEntry.DEFLATED
                    }
                    try {
                        zip.putNextEntry(zipEntry)
                    } catch (_: Exception) {
                        return exportFail(
                            Code.CORRUPT_ARCHIVE,
                            "Export interrupted for $interior: the package writer failed. Partial output discarded."
                        )
                    }
                    try {
                        FileInputStream(file).use { input ->
                            val buffer = ByteArray(IO_BUFFER_SIZE)
                            while (true) {
                                val read = input.read(buffer)
                                if (read == -1) break
                                observedBytes += read
                                fileDigest.update(buffer, 0, read)
                                if (headFilled < 4) {
                                    val copyCount = minOf(4 - headFilled, read)
                                    System.arraycopy(buffer, 0, head, headFilled, copyCount)
                                    headFilled += copyCount
                                }
                                zip.write(buffer, 0, read)
                            }
                        }
                    } catch (_: Exception) {
                        return exportFail(
                            Code.CORRUPT_ARCHIVE,
                            "Export interrupted for $interior: the package writer failed. Partial output discarded."
                        )
                    }
                    try {
                        zip.closeEntry()
                    } catch (_: Exception) {
                        return exportFail(
                            Code.CORRUPT_ARCHIVE,
                            "Export interrupted for $interior: the package writer failed. Partial output discarded."
                        )
                    }
                    if (hasDeniedMagic(head, headFilled)) {
                        return exportFail(Code.DENIED_FILE, "Executable content rejected: $interior.")
                    }
                    if (observedBytes != declaredSize) {
                        return exportFail(
                            Code.SIZE_MISMATCH,
                            "Installed size changed during export for $interior: listed $declaredSize, read $observedBytes."
                        )
                    }
                    expandedTotal += observedBytes
                    if (expandedTotal > maxExpandedBytes) {
                        return exportFail(
                            Code.PACKAGE_TOO_LARGE,
                            "Expanded package size exceeds the $maxExpandedBytes-byte cap."
                        )
                    }
                    observed.add(
                        Observed(interior, observedBytes, fileDigest.digest().joinToString("") { "%02x".format(it) }, method)
                    )
                }

                val manifestFiles = observed.map { ManifestFile(it.path, it.bytes, it.sha256, it.method) }.toMutableList()
                val checksumsJson = buildString {
                    append("{\n  \"entryId\": \"$entryId\",\n  \"files\": [\n")
                    manifestFiles.forEachIndexed { index, file ->
                        append("    {\"path\": \"${file.path}\", \"sha256\": \"${file.sha256}\"}")
                        if (index < manifestFiles.size - 1) append(",")
                        append("\n")
                    }
                    append("  ]\n}")
                }
                val checksumsBytes = checksumsJson.toByteArray(Charsets.UTF_8)
                manifestFiles.add(
                    ManifestFile(CHECKSUMS_NAME, checksumsBytes.size.toLong(), sha256Hex(checksumsBytes), "DEFLATE")
                )
                val manifest = Manifest(
                    packageVersion = PACKAGE_VERSION,
                    entryId = entryId,
                    upstreamRepo = "",
                    upstreamRev = "",
                    upstreamFile = "",
                    createdAt = createdAt,
                    files = manifestFiles
                )
                val manifestBytes = manifestJson(manifest).toByteArray(Charsets.UTF_8)
                try {
                    zip.putNextEntry(ZipEntry(CHECKSUMS_NAME).apply { method = ZipEntry.DEFLATED })
                    zip.write(checksumsBytes)
                    zip.closeEntry()
                    zip.putNextEntry(ZipEntry(MANIFEST_NAME).apply { method = ZipEntry.DEFLATED })
                    zip.write(manifestBytes)
                    zip.closeEntry()
                } catch (_: Exception) {
                    return exportFail(
                        Code.CORRUPT_ARCHIVE,
                        "Export interrupted while writing the package envelope. Partial output discarded."
                    )
                }
                return ExportResult(true, manifest = manifest, checksumsJson = checksumsJson)
            }
        } catch (_: Exception) {
            return exportFail(
                Code.CORRUPT_ARCHIVE,
                "Export interrupted: the destination cannot be written. Partial output discarded."
            )
        }
    }
}
