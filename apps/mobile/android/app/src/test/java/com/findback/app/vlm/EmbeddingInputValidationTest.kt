package com.findback.app.vlm

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/**
 * WB-05: the FindBackEmbeddings bridge must reject invalid batches before the
 * native embedder is touched — no empty/silent success, bounded batch and
 * string lengths matching the TS contract (services/embeddings.ts).
 */
class EmbeddingInputValidationTest {

    @Test fun acceptsTypicalBatchInOrder() {
        assertEquals(
            listOf("lost keys", "blue lanyard"),
            EmbeddingPlugin.validatedTexts(listOf("lost keys", "blue lanyard")),
        )
    }

    @Test fun rejectsMissingBatch() {
        assertNull(EmbeddingPlugin.validatedTexts(emptyList()))
    }

    @Test fun rejectsOversizedBatch() {
        assertNull(EmbeddingPlugin.validatedTexts(List(EmbeddingPlugin.MAX_TEXTS + 1) { "t$it" }))
    }

    @Test fun acceptsExactlyMaxBatch() {
        val batch = List(EmbeddingPlugin.MAX_TEXTS) { "t$it" }
        assertEquals(batch, EmbeddingPlugin.validatedTexts(batch))
    }

    @Test fun rejectsNullBlankAndOverlongTexts() {
        assertNull(EmbeddingPlugin.validatedTexts(listOf("ok", null)))
        assertNull(EmbeddingPlugin.validatedTexts(listOf("   ")))
        assertNull(EmbeddingPlugin.validatedTexts(listOf("x".repeat(EmbeddingPlugin.MAX_TEXT_LENGTH + 1))))
    }
}
