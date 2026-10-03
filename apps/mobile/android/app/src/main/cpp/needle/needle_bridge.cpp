/*
 * FindBack Needle JNI bridge over the pinned Cactus needle3 engine
 * (third_party/needle/<abi>/libneedle.a + needle.h).
 *
 * Threading: the engine is process-global and non-thread-safe (see
 * needle.h), so every call below must happen under the Kotlin-side single
 * lock in FindbackNeedle — never concurrently.
 *
 * Telemetry: NEEDLE_TELEMETRY=0 + DO_NOT_TRACK=1 are set in JNI_OnLoad,
 * before any needle_* call can run. This is the vendor off-switch; the JS
 * telemetryGate (default-OFF diagnostics ring) stays as the second gate.
 *
 * Model memory: needle_load takes caller-owned bytes. The .cact stays
 * malloc'd for the process lifetime of the load (freed on unload) because
 * the engine reads the weights in place.
 */
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <string>
#include <jni.h>

#include "needle.h"

namespace {

unsigned char *g_model_bytes = nullptr;
unsigned long long g_model_size = 0;

const char *last_error_or(const char *fallback) {
    const char *err = needle_last_error();
    return (err != nullptr && err[0] != '\0') ? err : fallback;
}

jstring to_jstring(JNIEnv *env, const char *text) {
    return env->NewStringUTF(text != nullptr ? text : "");
}

void throw_native(JNIEnv *env, const char *code, const char *detail) {
    jclass klass = env->FindClass("com/findback/app/needle/NativeNeedleException");
    if (klass == nullptr) return;
    jmethodID ctor =
        env->GetMethodID(klass, "<init>", "(Ljava/lang/String;Ljava/lang/String;)V");
    if (ctor == nullptr) return;
    jstring jcode = to_jstring(env, code);
    jstring jdetail = to_jstring(env, detail);
    jthrowable ex =
        static_cast<jthrowable>(env->NewObject(klass, ctor, jcode, jdetail));
    if (ex != nullptr) env->Throw(ex);
}

std::string read_file(const char *path, bool &ok) {
    ok = false;
    std::string data;
    FILE *file = fopen(path, "rb");
    if (file == nullptr) return data;
    if (fseek(file, 0, SEEK_END) != 0) {
        fclose(file);
        return data;
    }
    long size = ftell(file);
    if (size <= 0 || size > 256 * 1024 * 1024) {
        fclose(file);
        return data;
    }
    rewind(file);
    data.resize(static_cast<size_t>(size));
    size_t got = fread(data.data(), 1, data.size(), file);
    fclose(file);
    if (got != data.size()) {
        data.clear();
        return data;
    }
    ok = true;
    return data;
}

}  // namespace

JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM * /*vm*/, void * /*reserved*/) {
    /* Vendor telemetry off-switch: must precede any needle_* call. */
    setenv("NEEDLE_TELEMETRY", "0", 1);
    setenv("DO_NOT_TRACK", "1", 1);
    return JNI_VERSION_1_6;
}

extern "C" {

/* Loads the .cact at path; throws NativeNeedleException on failure. */
JNIEXPORT void JNICALL
Java_com_findback_app_needle_NeedleBridge_nativeLoad(JNIEnv *env, jobject /*thiz*/,
                                                     jstring jpath) {
    if (g_model_bytes != nullptr) return; /* already resident: idempotent */
    const char *path = env->GetStringUTFChars(jpath, nullptr);
    if (path == nullptr) {
        throw_native(env, "load_failed", "null model path");
        return;
    }
    bool ok = false;
    std::string data = read_file(path, ok);
    env->ReleaseStringUTFChars(jpath, path);
    if (!ok || data.empty()) {
        throw_native(env, "model_not_installed", "cannot read model weights");
        return;
    }
    unsigned char *bytes =
        static_cast<unsigned char *>(malloc(data.size()));
    if (bytes == nullptr) {
        throw_native(env, "load_failed", "out of memory for model weights");
        return;
    }
    memcpy(bytes, data.data(), data.size());
    int rc = needle_load(bytes, static_cast<unsigned long long>(data.size()));
    if (rc < 0) {
        const char *detail = last_error_or("needle_load failed");
        char buf[512];
        snprintf(buf, sizeof(buf), "%s", detail);
        free(bytes);
        throw_native(env, "load_failed", buf);
        return;
    }
    g_model_bytes = bytes;
    g_model_size = static_cast<unsigned long long>(data.size());
}

/* Bitmask of loaded model kinds (NEEDLE_TEXT=1, NEEDLE_SPEECH=2). */
JNIEXPORT jint JNICALL
Java_com_findback_app_needle_NeedleBridge_nativeModels(JNIEnv *env, jobject /*thiz*/) {
    (void)env;
    return needle_models();
}

/* Embedding dimension via the null-output probe (no compute). */
JNIEXPORT jint JNICALL
Java_com_findback_app_needle_NeedleBridge_nativeEmbedDim(JNIEnv *env, jobject /*thiz*/) {
    int dim = needle_embed("probe", nullptr, 0, nullptr, 0);
    if (dim <= 0) {
        throw_native(env, "embed_failed", last_error_or("dimension probe failed"));
        return -1;
    }
    return dim;
}

/* Embeds one text; returns the float row. Throws on failure. */
JNIEXPORT jfloatArray JNICALL
Java_com_findback_app_needle_NeedleBridge_nativeEmbed(JNIEnv *env, jobject /*thiz*/,
                                                      jstring jtext, jint dim) {
    const char *text = env->GetStringUTFChars(jtext, nullptr);
    if (text == nullptr || dim <= 0 || dim > 8192) {
        if (text != nullptr) env->ReleaseStringUTFChars(jtext, text);
        throw_native(env, "embed_failed", "invalid embed request");
        return nullptr;
    }
    float *out = static_cast<float *>(malloc(sizeof(float) * static_cast<size_t>(dim)));
    if (out == nullptr) {
        env->ReleaseStringUTFChars(jtext, text);
        throw_native(env, "embed_failed", "out of memory for embedding");
        return nullptr;
    }
    int rc = needle_embed(text, nullptr, 0, out, dim);
    env->ReleaseStringUTFChars(jtext, text);
    if (rc < 0) {
        const char *detail = last_error_or("needle_embed failed");
        char buf[512];
        snprintf(buf, sizeof(buf), "%s", detail);
        free(out);
        throw_native(env, "embed_failed", buf);
        return nullptr;
    }
    jfloatArray result = env->NewFloatArray(dim);
    if (result == nullptr) {
        free(out);
        return nullptr;
    }
    env->SetFloatArrayRegion(result, 0, dim, out);
    free(out);
    return result;
}

/* Runs one text completion (extraction prompts go through here; the tools
   envelope is configured via nativeInitTools). Returns the raw output. */
JNIEXPORT jstring JNICALL
Java_com_findback_app_needle_NeedleBridge_nativeComplete(JNIEnv *env, jobject /*thiz*/,
                                                         jstring jinput,
                                                         jint max_new_tokens) {
    const char *input = env->GetStringUTFChars(jinput, nullptr);
    if (input == nullptr) {
        throw_native(env, "generation_failed", "null input");
        return nullptr;
    }
    const int capacity = 8192;
    char *out = static_cast<char *>(malloc(static_cast<size_t>(capacity)));
    if (out == nullptr) {
        env->ReleaseStringUTFChars(jinput, input);
        throw_native(env, "generation_failed", "out of memory for output");
        return nullptr;
    }
    int tokens = max_new_tokens > 0 ? max_new_tokens : 256;
    int rc = needle_complete(input, nullptr, 0, tokens, out, capacity);
    env->ReleaseStringUTFChars(jinput, input);
    if (rc < 0) {
        const char *detail = last_error_or("needle_complete failed");
        char buf[512];
        snprintf(buf, sizeof(buf), "%s", detail);
        free(out);
        throw_native(env, "generation_failed", buf);
        return nullptr;
    }
    out[capacity - 1] = '\0';
    jstring result = to_jstring(env, out);
    free(out);
    return result;
}

/* Configures the system prompt + single-record tool schema envelope. */
JNIEXPORT void JNICALL
Java_com_findback_app_needle_NeedleBridge_nativeInitTools(JNIEnv *env, jobject /*thiz*/,
                                                          jstring jsystem,
                                                          jstring jtools) {
    const char *system = jsystem != nullptr ? env->GetStringUTFChars(jsystem, nullptr) : nullptr;
    const char *tools = jtools != nullptr ? env->GetStringUTFChars(jtools, nullptr) : nullptr;
    int rc = needle_init(system, tools, nullptr);
    if (system != nullptr) env->ReleaseStringUTFChars(jsystem, system);
    if (tools != nullptr) env->ReleaseStringUTFChars(jtools, tools);
    if (rc < 0) {
        throw_native(env, "init_failed", last_error_or("needle_init failed"));
    }
}

JNIEXPORT void JNICALL
Java_com_findback_app_needle_NeedleBridge_nativeReset(JNIEnv * /*env*/, jobject /*thiz*/) {
    needle_reset();
}

/* Releases the engine state and the resident weights. Idempotent. */
JNIEXPORT void JNICALL
Java_com_findback_app_needle_NeedleBridge_nativeUnload(JNIEnv * /*env*/, jobject /*thiz*/) {
    needle_reset();
    if (g_model_bytes != nullptr) {
        free(g_model_bytes);
        g_model_bytes = nullptr;
        g_model_size = 0;
    }
}

}  // extern "C"
