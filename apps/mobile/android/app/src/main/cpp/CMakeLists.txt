cmake_minimum_required(VERSION 3.22.1)

# FindBack on-device capability probes. One tiny shared library, no third-party
# sources: every probe below uses dlopen()+dlsym() against OPTIONAL system
# libraries and degrades to an "unavailable" status string when the library,
# symbol, or device support is absent. Nothing here links the probed
# libraries at build time (only libdl/liblog), so missing drivers can never
# break install or load — absence is data, not an error.
project("findback_probe")

add_library(findback_probe SHARED probe/probe.c)

find_library(log-lib log)
target_link_libraries(findback_probe ${log-lib} dl)

# FindBack Needle bridge over the pinned Cactus engine. The static engine
# archives are build inputs fetched by scripts/fetch-needle-model.mjs
# (--engine-only, wired as the fetchNeedleEngine Gradle task) into
# third_party/needle/<android-abi>/ (arm64-v8a). ABIs without a fetched
# engine skip the bridge — the Kotlin plugin then reports Needle
# unavailable there instead of breaking the build.
if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/third_party/needle/${ANDROID_ABI}/libneedle.a" AND
   EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/third_party/needle/${ANDROID_ABI}/needle.h")
    add_library(needle STATIC IMPORTED)
    set_target_properties(needle PROPERTIES
        IMPORTED_LOCATION
        "${CMAKE_CURRENT_SOURCE_DIR}/third_party/needle/${ANDROID_ABI}/libneedle.a"
        INTERFACE_INCLUDE_DIRECTORIES
        "${CMAKE_CURRENT_SOURCE_DIR}/third_party/needle/${ANDROID_ABI}")
    add_library(findback_needle SHARED needle/needle_bridge.cpp)
    target_link_libraries(findback_needle needle ${log-lib} dl)
else()
    message(STATUS "findback_needle skipped for ${ANDROID_ABI}: no fetched engine")
endif()

# FindBack llama.cpp lab bridge over the pinned upstream source
# (third_party/llama.cpp at tag v0.5.0, fetched by
# scripts/fetch-llama-cpp.mjs via the fetchLlamaCpp Gradle task).
# CPU-only lab target on arm64-v8a: no GPU offload, no OpenMP, portable
# ARM variants. Other ABIs skip — lab measurement happens on arm64
# hardware; the Kotlin plugin reports unavailable elsewhere.
if(ANDROID_ABI STREQUAL "arm64-v8a" AND
   EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/CMakeLists.txt")
    set(BUILD_SHARED_LIBS ON)
    set(LLAMA_BUILD_APP OFF)
    set(LLAMA_BUILD_COMMON ON)
    set(LLAMA_BUILD_TESTS OFF)
    set(LLAMA_BUILD_EXAMPLES OFF)
    set(LLAMA_BUILD_SERVER OFF)
    set(LLAMA_BUILD_TOOLS OFF)
    set(LLAMA_BUILD_MTMD ON)
    set(MTMD_VIDEO OFF CACHE BOOL "No video subprocesses" FORCE)
    set(LLAMA_OPENSSL OFF)
    set(GGML_NATIVE OFF)
    set(GGML_OPENMP OFF)
    set(GGML_LLAMAFILE OFF)
    set(GGML_BACKEND_DL ON)
    set(GGML_CPU_ALL_VARIANTS ON)
    add_subdirectory(third_party/llama.cpp build-llama EXCLUDE_FROM_ALL)
    add_library(findback_llama SHARED llama/llama_bridge.cpp)
    target_link_libraries(findback_llama llama llama-common mtmd ${log-lib} dl)
    target_include_directories(findback_llama PRIVATE
        "${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/include"
        "${CMAKE_CURRENT_SOURCE_DIR}/third_party/llama.cpp/common")
else()
    message(STATUS "findback_llama skipped for ${ANDROID_ABI}: lab arm64 target only")
endif()
