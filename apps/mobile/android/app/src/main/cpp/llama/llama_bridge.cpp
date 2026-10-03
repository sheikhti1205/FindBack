/*
 * FindBack llama.cpp lab bridge over the pinned upstream source
 * (third_party/llama.cpp at tag v0.5.0, CPU-only lab target).
 *
 * Lab scope: this bridge serves GGUF challenger evaluation behind the
 * TS license gate + benchmark/eval channel enforcement. It is NEVER on
 * the production path: no orchestrator registration, no routing.
 *
 * Threading: one process-global session; every call below must happen
 * under the Kotlin-side single lock in FindbackLlama. Cancellation is
 * cooperative: nativeCancel raises a flag the generation loop checks.
 */
#include <atomic>
#include <cstdlib>
#include <cstring>
#include <jni.h>
#include <string>
#include <vector>

#include "llama.h"

namespace {

llama_model *g_model = nullptr;
llama_context *g_ctx = nullptr;
llama_sampler *g_smpl = nullptr;
std::atomic<bool> g_cancel{false};

void throw_lab(JNIEnv *env, const char *code, const char *detail) {
    jclass klass = env->FindClass("com/findback/app/llama/NativeLlamaException");
    if (klass == nullptr) return;
    jmethodID ctor =
        env->GetMethodID(klass, "<init>", "(Ljava/lang/String;Ljava/lang/String;)V");
    if (ctor == nullptr) return;
    jstring jcode = env->NewStringUTF(code != nullptr ? code : "lab_failed");
    jstring jdetail = env->NewStringUTF(detail != nullptr ? detail : "");
    jthrowable ex =
        static_cast<jthrowable>(env->NewObject(klass, ctor, jcode, jdetail));
    if (ex != nullptr) env->Throw(ex);
}

void free_session() {
    if (g_smpl != nullptr) {
        llama_sampler_free(g_smpl);
        g_smpl = nullptr;
    }
    if (g_ctx != nullptr) {
        llama_free(g_ctx);
        g_ctx = nullptr;
    }
    if (g_model != nullptr) {
        llama_model_free(g_model);
        g_model = nullptr;
    }
}

bool decode_tokens(std::vector<llama_token> &tokens) {
    if (tokens.empty()) return true;
    llama_batch batch = llama_batch_get_one(tokens.data(), (int32_t)tokens.size());
    return llama_decode(g_ctx, batch) == 0;
}

}  // namespace

extern "C" {

JNIEXPORT void JNICALL
Java_com_findback_app_llama_LlamaBridge_nativeInit(JNIEnv *env, jobject /*thiz*/) {
    (void)env;
    llama_backend_init();
}

JNIEXPORT void JNICALL
Java_com_findback_app_llama_LlamaBridge_nativeLoad(JNIEnv *env, jobject /*thiz*/,
                                                   jstring jpath, jint n_ctx,
                                                   jint n_threads) {
    free_session();
    const char *path = env->GetStringUTFChars(jpath, nullptr);
    if (path == nullptr) {
        throw_lab(env, "load_failed", "null model path");
        return;
    }
    std::string model_path(path);
    env->ReleaseStringUTFChars(jpath, path);

    llama_model_params mparams = llama_model_default_params();
    mparams.n_gpu_layers = 0; /* lab CPU target: no GPU offload */
    g_model = llama_model_load_from_file(model_path.c_str(), mparams);
    if (g_model == nullptr) {
        throw_lab(env, "load_failed", "llama_model_load_from_file failed");
        return;
    }
    llama_context_params cparams = llama_context_default_params();
    cparams.n_ctx = n_ctx > 0 ? (uint32_t)n_ctx : 2048;
    cparams.n_threads = n_threads > 0 ? n_threads : 4;
    cparams.n_threads_batch = cparams.n_threads;
    g_ctx = llama_init_from_model(g_model, cparams);
    if (g_ctx == nullptr) {
        free_session();
        throw_lab(env, "load_failed", "llama_init_from_model failed");
        return;
    }
    /* Greedy lab sampler (temperature 0.0 evaluation default). */
    g_smpl = llama_sampler_init_greedy();
    if (g_smpl == nullptr) {
        free_session();
        throw_lab(env, "load_failed", "sampler init failed");
        return;
    }
    g_cancel.store(false);
}

/* Prefills the prompt; returns the token count consumed. */
JNIEXPORT jint JNICALL
Java_com_findback_app_llama_LlamaBridge_nativeBegin(JNIEnv *env, jobject /*thiz*/,
                                                    jstring jprompt) {
    if (g_ctx == nullptr || g_model == nullptr || g_smpl == nullptr) {
        throw_lab(env, "lab_not_loaded", "no lab session");
        return -1;
    }
    const char *prompt = env->GetStringUTFChars(jprompt, nullptr);
    if (prompt == nullptr) {
        throw_lab(env, "generation_failed", "null prompt");
        return -1;
    }
    std::string text(prompt);
    env->ReleaseStringUTFChars(jprompt, prompt);

    const struct llama_vocab *vocab = llama_model_get_vocab(g_model);
    const int32_t n_ctx = (int32_t)llama_n_ctx(g_ctx);
    std::vector<llama_token> tokens(n_ctx > 0 ? (size_t)n_ctx : 2048);
    int32_t n = llama_tokenize(vocab, text.c_str(), (int32_t)text.size(), tokens.data(),
                               (int32_t)tokens.size(), true /* add_bos */, true /* special */);
    if (n < 0) {
        throw_lab(env, "generation_failed", "prompt exceeds context");
        return -1;
    }
    tokens.resize((size_t)n);
    g_cancel.store(false);
    if (!decode_tokens(tokens)) {
        throw_lab(env, "generation_failed", "prompt prefill failed");
        return -1;
    }
    return n;
}

/* Samples one next piece; null at end-of-generation or on cancel. */
JNIEXPORT jstring JNICALL
Java_com_findback_app_llama_LlamaBridge_nativeNext(JNIEnv *env, jobject /*thiz*/) {
    if (g_ctx == nullptr || g_model == nullptr || g_smpl == nullptr) {
        throw_lab(env, "lab_not_loaded", "no lab session");
        return nullptr;
    }
    if (g_cancel.load()) return nullptr;
    const struct llama_vocab *vocab = llama_model_get_vocab(g_model);
    llama_token next = llama_sampler_sample(g_smpl, g_ctx, -1);
    if (llama_vocab_is_eog(vocab, next)) return nullptr;
    llama_sampler_accept(g_smpl, next);
    const char *piece = llama_vocab_get_text(vocab, next);
    if (piece == nullptr) return env->NewStringUTF("");
    jstring result = env->NewStringUTF(piece);
    std::vector<llama_token> one = {next};
    if (!decode_tokens(one)) {
        throw_lab(env, "generation_failed", "decode failed");
        return nullptr;
    }
    return result;
}

JNIEXPORT void JNICALL
Java_com_findback_app_llama_LlamaBridge_nativeCancel(JNIEnv *env, jobject /*thiz*/) {
    (void)env;
    g_cancel.store(true);
}

JNIEXPORT jstring JNICALL
Java_com_findback_app_llama_LlamaBridge_nativeSystemInfo(JNIEnv *env, jobject /*thiz*/) {
    (void)env;
    char buf[1024];
    snprintf(buf, sizeof(buf), "%s", llama_print_system_info());
    return env->NewStringUTF(buf);
}

JNIEXPORT void JNICALL
Java_com_findback_app_llama_LlamaBridge_nativeUnload(JNIEnv *env, jobject /*thiz*/) {
    (void)env;
    g_cancel.store(false);
    free_session();
}

}  // extern "C"
