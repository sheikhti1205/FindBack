package com.findback.app.llama

/** Typed failure from the llama.cpp lab JNI bridge (code + detail). */
class NativeLlamaException(val code: String, message: String) : Exception(message)
