# SPDX-License-Identifier: MIT

if(CONFIG_ODD_DIRECTIONAL_DPI)
  zephyr_include_directories(include)
  zephyr_library()
  zephyr_library_include_directories(../../core)
  zephyr_library_sources(
    src/odd_input_filter.c
    ../../core/directional_dpi.c
  )
  # struct input_listener became input_callback mid 3.6.99 (2024-03-19), so the
  # version number cannot tell them apart (nRF Connect SDK 2.7 is 3.6.99 with the new name)
  file(STRINGS ${ZEPHYR_BASE}/include/zephyr/input/input.h odd_input_callback REGEX "struct input_callback {")
  if(odd_input_callback)
    zephyr_library_compile_definitions(ODD_HAS_INPUT_CALLBACK)
  endif()
endif()
