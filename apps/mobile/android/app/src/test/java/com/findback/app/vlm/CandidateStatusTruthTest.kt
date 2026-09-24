package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * AI-03/AI-04/AI-07 native portion: selected vs verified vs resident truth.
 *
 * The old `getTextRuntimeStatus` candidate branch reported `ready:true`,
 * `textReady:true` and `residentModelId=<pointer>` from a hash-verified
 * pointer alone; the old `getCandidateActive` exposed only the pointer.
 * These tests pin the honest contract: residency is claimed only for a
 * genuinely resident engine, `entryId` stays for existing clients, and the
 * new keys are additive.
 */
class CandidateStatusTruthTest {

    @Test
    fun activePayloadRetainsEntryIdAndAddsTruthFields() {
        val id = "qwen3-0.6b-litert-int8"
        val payload = candidateActivePayload(
            selectedEntryId = id,
            installedVerified = true,
            residentEntryId = id,
            initialized = true
        )
        assertEquals(id, payload.getString("entryId"), "legacy entryId retained")
        assertEquals(id, payload.getString("selectedEntryId"))
        assertTrue(payload.getBoolean("installedVerified"))
        assertEquals(id, payload.getString("residentEntryId"))
        assertTrue(payload.getBoolean("initialized"))
    }

    @Test
    fun activePayloadDistinguishesSelectedFromResident() {
        // Cold restart / post-probe: pointer selected and bytes verified,
        // but no engine resident.
        val payload = candidateActivePayload(
            selectedEntryId = "qwen3-0.6b-litert-int8",
            installedVerified = true,
            residentEntryId = null,
            initialized = false
        )
        assertEquals("qwen3-0.6b-litert-int8", payload.getString("entryId"))
        assertTrue(payload.isNull("residentEntryId"))
        assertFalse(payload.getBoolean("initialized"))
    }

    @Test
    fun activePayloadWithNothingSelectedReadsEmpty() {
        val payload = candidateActivePayload(
            selectedEntryId = null,
            installedVerified = false,
            residentEntryId = null,
            initialized = false
        )
        assertTrue(payload.isNull("entryId"))
        assertFalse(payload.getBoolean("installedVerified"))
        assertFalse(payload.getBoolean("initialized"))
    }

    @Test
    fun staleSelectedCandidateIsNotReadyOrResident() {
        // AI-03 core: verified weights on disk must not pretend an unloaded
        // candidate is resident/ready.
        val id = "qwen3-0.6b-litert-mixed-int4"
        val status = candidateTextStatusPayload(
            selectedEntryId = id,
            residentTextEntryId = null,
            backendWire = VlmEngineBackend.GPU.wire
        )
        assertEquals(id, status.getString("modelId"))
        assertEquals(id, status.getString("selectedEntryId"))
        assertTrue(status.getBoolean("installedVerified"))
        assertTrue(status.getBoolean("installed"))
        assertTrue(status.getBoolean("modelFilePresent"))
        assertFalse(status.getBoolean("ready"), "selected-but-unloaded must not read ready")
        assertFalse(status.getBoolean("textReady"), "selected-but-unloaded must not read textReady")
        assertFalse(status.getBoolean("initialized"))
        assertTrue(status.isNull("residentModelId"), "no fictional resident id")
    }

    @Test
    fun genuinelyResidentCandidateReadsReady() {
        val id = "qwen3-0.6b-litert-int8"
        val status = candidateTextStatusPayload(
            selectedEntryId = id,
            residentTextEntryId = id,
            backendWire = VlmEngineBackend.GPU.wire
        )
        assertTrue(status.getBoolean("ready"))
        assertTrue(status.getBoolean("textReady"))
        assertTrue(status.getBoolean("initialized"))
        assertEquals(id, status.getString("residentModelId"))
    }

    @Test
    fun otherEntryResidentDoesNotLeakIntoSelectedStatus() {
        // Resident B must not make selected A read ready.
        val status = candidateTextStatusPayload(
            selectedEntryId = "qwen3-0.6b-litert-mixed-int4",
            residentTextEntryId = "qwen3-0.6b-litert-int8",
            backendWire = VlmEngineBackend.GPU.wire
        )
        assertFalse(status.getBoolean("ready"))
        assertFalse(status.getBoolean("textReady"))
        assertTrue(status.isNull("residentModelId"))
    }
}
