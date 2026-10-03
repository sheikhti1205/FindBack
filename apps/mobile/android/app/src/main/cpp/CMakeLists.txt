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
