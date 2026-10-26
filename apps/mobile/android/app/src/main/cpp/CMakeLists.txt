cmake_minimum_required(VERSION 3.22.1)

project("findback_needle")
find_library(log-lib log)

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
