import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('Drive legacy activity results are registered with the installed Capacitor router', () => {
  const source = readFileSync(new URL('../apps/mobile/android/app/src/main/java/com/findback/app/DriveAuthPlugin.java', import.meta.url), 'utf8');
  const router = readFileSync(new URL('../node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/Bridge.java', import.meta.url), 'utf8');
  assert.match(router, /getPluginWithRequestCode\(requestCode\)/);
  const annotation = source.match(/@CapacitorPlugin\(([^)]*)\)/)?.[1] ?? '';
  for (const name of ['REQUEST_ACCOUNT', 'REQUEST_RESOLUTION']) {
    const code = source.match(new RegExp(`int ${name} = (0x[0-9A-Fa-f]+);`))?.[1];
    assert.ok(code, `${name} has a fixed routing code`);
    assert.ok(annotation.includes(code), `${name} must be declared in requestCodes or its callback is dropped`);
  }
});
