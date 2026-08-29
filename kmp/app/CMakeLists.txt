cmake_minimum_required(VERSION 3.22.1)

project(revivalside_node_bridge)

add_library(revivalside_node_bridge SHARED src/main/cpp/native-lib.cpp)
add_executable(revivalside_dotnet_host src/main/cpp/dotnet-host.cpp)

set_target_properties(
    revivalside_dotnet_host
    PROPERTIES
    PREFIX "lib"
    OUTPUT_NAME "revivalside_dotnet_host"
    SUFFIX ".so"
)

target_include_directories(
    revivalside_node_bridge
    PRIVATE
    libnode/include/node
)

add_library(libnode SHARED IMPORTED)
set_target_properties(
    libnode
    PROPERTIES
    IMPORTED_LOCATION
    ${CMAKE_CURRENT_SOURCE_DIR}/libnode/bin/${ANDROID_ABI}/libnode.so
)

find_library(log-lib log)

target_link_libraries(
    revivalside_node_bridge
    libnode
    ${log-lib}
)

target_link_libraries(
    revivalside_dotnet_host
    dl
    ${log-lib}
)

foreach(target revivalside_node_bridge revivalside_dotnet_host)
    target_link_options(
        ${target}
        PRIVATE
        "-Wl,-z,max-page-size=16384"
        "-Wl,-z,common-page-size=16384"
    )
endforeach()
