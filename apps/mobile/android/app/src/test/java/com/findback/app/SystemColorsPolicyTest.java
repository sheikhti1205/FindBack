package com.findback.app;

import static org.junit.Assert.*;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.Test;

public class SystemColorsPolicyTest {
    @Test public void below31DoesNotReadAnyDynamicResource() {
        AtomicInteger calls = new AtomicInteger();
        assertTrue(SystemColorsPolicy.read(30, false, id -> { calls.incrementAndGet(); return 0; }).isEmpty());
        assertEquals(0, calls.get());
    }
    @Test public void api31LightUsesMaterialPrimaryTones() {
        Map<String, Integer> ids = SystemColorsPolicy.read(31, false, id -> id);
        assertEquals(Integer.valueOf(android.R.color.system_accent1_600), ids.get("primary"));
        assertEquals(Integer.valueOf(android.R.color.system_accent1_0), ids.get("onPrimary"));
        assertEquals(Integer.valueOf(android.R.color.system_accent1_100), ids.get("primaryContainer"));
        assertEquals(Integer.valueOf(android.R.color.system_accent1_900), ids.get("onPrimaryContainer"));
        assertEquals(ids.get("onPrimaryContainer"), ids.get("link"));
    }
    @Test public void api33DarkUsesMaterialPrimaryTones() {
        Map<String, Integer> ids = SystemColorsPolicy.read(33, true, id -> id);
        assertEquals(Integer.valueOf(android.R.color.system_accent1_200), ids.get("primary"));
        assertEquals(Integer.valueOf(android.R.color.system_accent1_800), ids.get("onPrimary"));
        assertEquals(Integer.valueOf(android.R.color.system_accent1_700), ids.get("primaryContainer"));
        assertEquals(Integer.valueOf(android.R.color.system_accent1_100), ids.get("onPrimaryContainer"));
        assertEquals(ids.get("primary"), ids.get("link"));
    }
    @Test public void api34AndAboveUseActualSystemRoles() {
        Map<String, Integer> light = SystemColorsPolicy.read(34, false, id -> id);
        Map<String, Integer> dark = SystemColorsPolicy.read(36, true, id -> id);
        assertEquals(Integer.valueOf(android.R.color.system_primary_light), light.get("primary"));
        assertEquals(Integer.valueOf(android.R.color.system_on_primary_light), light.get("onPrimary"));
        assertEquals(Integer.valueOf(android.R.color.system_primary_container_light), light.get("primaryContainer"));
        assertEquals(Integer.valueOf(android.R.color.system_on_primary_container_light), light.get("onPrimaryContainer"));
        assertEquals(Integer.valueOf(android.R.color.system_primary_dark), dark.get("primary"));
        assertEquals(Integer.valueOf(android.R.color.system_on_primary_dark), dark.get("onPrimary"));
        assertEquals(Integer.valueOf(android.R.color.system_primary_container_dark), dark.get("primaryContainer"));
        assertEquals(Integer.valueOf(android.R.color.system_on_primary_container_dark), dark.get("onPrimaryContainer"));
        assertEquals(5, light.size()); assertEquals(5, dark.size());
    }
}
