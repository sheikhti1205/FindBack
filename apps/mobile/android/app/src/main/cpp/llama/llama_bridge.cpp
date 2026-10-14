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
#include <algorithm>
#include <stdexcept>

#include "llama.h"
#include "chat.h"
#include "mtmd.h"
#include "mtmd-helper.h"

namespace {

llama_model *g_model = nullptr;
llama_context *g_ctx = nullptr;
llama_sampler *g_smpl = nullptr;
mtmd_context *g_vision = nullptr;
common_chat_templates_ptr g_template;
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
    g_template.reset();
    if (g_vision != nullptr) { mtmd_free(g_vision); g_vision = nullptr; }
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
    const size_t batch_size = llama_n_batch(g_ctx);
    for (size_t i = 0; i < tokens.size(); i += batch_size) {
        if (g_cancel.load()) return false;
        llama_batch batch = llama_batch_get_one(tokens.data() + i, (int32_t)std::min(batch_size, tokens.size() - i));
        if (llama_decode(g_ctx, batch) != 0) return false;
    }
    return true;
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
    cparams.abort_callback = [](void *) { return g_cancel.load(); };
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
    try {
        if (llama_model_chat_template(g_model, nullptr) == nullptr) throw std::runtime_error("missing chat template");
        g_template = common_chat_templates_init(g_model, "");
    } catch (...) { free_session(); throw_lab(env, "load_failed", "chat template unavailable"); }
}

JNIEXPORT void JNICALL
Java_com_findback_app_llama_LlamaBridge_nativeLoadProjector(JNIEnv *env, jobject, jstring jpath) {
    const char *path = env->GetStringUTFChars(jpath, nullptr);
    if (!path || !g_model) { throw_lab(env, "load_failed", "projector unavailable"); return; }
    mtmd_context_params params = mtmd_context_params_default();
    params.use_gpu = false;
    params.n_threads = 4;
    params.warmup = false;
    g_vision = mtmd_init_from_file(path, g_model, params);
    env->ReleaseStringUTFChars(jpath, path);
    if (!g_vision || !mtmd_support_vision(g_vision)) { free_session(); throw_lab(env, "load_failed", "projector failed"); }
}

/* Prefills the prompt; returns the token count consumed. */
JNIEXPORT jint JNICALL
Java_com_findback_app_llama_LlamaBridge_nativeBegin(JNIEnv *env, jobject /*thiz*/,
                                                    jstring jprompt, jbyteArray jrgb, jint width, jint height) {
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

    llama_memory_clear(llama_get_memory(g_ctx), true);
    llama_sampler_reset(g_smpl);
    const bool image = jrgb != nullptr;
    try {
        common_chat_templates_inputs inputs;
        inputs.enable_thinking = false;
        common_chat_msg msg;
        msg.role = "user";
        if (image) {
            msg.content_parts.push_back({"media_marker", mtmd_default_marker()});
            msg.content_parts.push_back({"text", text});
        } else msg.content = text;
        inputs.messages.push_back(msg);
        text = common_chat_templates_apply(g_template.get(), inputs).prompt;
    } catch (...) { throw_lab(env, "generation_failed", "chat template failed"); return -1; }
    if (image) {
        if (!g_vision || width <= 0 || height <= 0 || width > 1024 || height > 1024 || env->GetArrayLength(jrgb) != width * height * 3) {
            throw_lab(env, "generation_failed", "invalid image input"); return -1;
        }
        std::vector<unsigned char> pixels(width * height * 3);
        env->GetByteArrayRegion(jrgb, 0, (jsize)pixels.size(), reinterpret_cast<jbyte *>(pixels.data()));
        mtmd_bitmap *bitmap = mtmd_bitmap_init(width, height, pixels.data());
        const mtmd_bitmap *bitmaps[] = {bitmap};
        mtmd_input_chunks *chunks = mtmd_input_chunks_init();
        mtmd_input_text input{text.c_str(), text.size(), true, true};
        int result = mtmd_tokenize(g_vision, chunks, &input, bitmaps, 1);
        llama_pos past = 0;
        if (!result && mtmd_helper_get_n_tokens(chunks) + 256 > llama_n_ctx(g_ctx)) result = -1;
        if (!result && !g_cancel.load()) result = mtmd_helper_eval_chunks(g_vision, g_ctx, chunks, 0, 0, llama_n_batch(g_ctx), true, &past);
        mtmd_input_chunks_free(chunks); mtmd_bitmap_free(bitmap);
        if (result || g_cancel.load()) { throw_lab(env, "generation_failed", "vision prefill failed"); return -1; }
        return past;
    }
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
    if (!decode_tokens(tokens)) {
        throw_lab(env, "generation_failed", "prompt prefill failed");
        return -1;
    }
    return n;
}

/* Samples one next piece; null at end-of-generation or on cancel. */
JNIEXPORT jbyteArray JNICALL
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
    char piece[256];
    int32_t size = llama_token_to_piece(vocab, next, piece, sizeof(piece), 0, false);
    if (size < 0) { throw_lab(env, "generation_failed", "token piece too large"); return nullptr; }
    jbyteArray result = env->NewByteArray(size);
    env->SetByteArrayRegion(result, 0, size, reinterpret_cast<jbyte *>(piece));
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

JNIEXPORT void JNICALL
Java_com_findback_app_llama_LlamaBridge_nativeResetCancellation(JNIEnv *, jobject) { g_cancel.store(false); }

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
