package com.findback.app.needle

/** Typed failure from the Needle JNI bridge (code + engine detail). */
class NativeNeedleException(val code: String, message: String) : Exception(message)
