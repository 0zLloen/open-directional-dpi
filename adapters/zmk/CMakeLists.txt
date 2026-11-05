# SPDX-License-Identifier: MIT

if(CONFIG_ZMK_INPUT_PROCESSOR_DIRECTIONAL_DPI)
  zephyr_include_directories(${CMAKE_CURRENT_LIST_DIR}/../../core)
  zephyr_library()
  zephyr_library_sources(
    ${CMAKE_CURRENT_LIST_DIR}/../../core/directional_dpi.c
    src/input_processor_directional_dpi.c
  )
endif()
