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
# third_party/needle/<android-abi>/: arm64-v8a and x86_64. ABIs without a
# fetched engine (32-bit ARM/x86) skip the bridge — the Kotlin plugin then
# reports Needle unavailable there instead of breaking the build.
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
