package com.findback.app.download

import java.io.File
import java.io.IOException
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ModelFileDeletionTest {
    @get:Rule val temporary = TemporaryFolder()

    @Test fun removesAFileAndItsDirectoryIdempotently() {
        val directory = temporary.newFolder("model")
        File(directory, "weights.bin").writeText("test bytes")
        deleteModelFile(directory)
        assertFalse(directory.exists())
        deleteModelFile(directory)
    }

    @Test fun refusesToClaimSuccessWhenTheFileStillExists() {
        val undeletable = object : File("undeletable-test-file") {
            override fun exists() = true
            override fun isDirectory() = false
            override fun delete() = false
        }
        assertThrows(IOException::class.java) { deleteModelFile(undeletable) }
    }

    @Test fun propagatesDeletionErrorsInsteadOfClaimingSuccess() {
        val denied = object : File("denied-test-file") {
            override fun exists() = true
            override fun isDirectory() = false
            override fun delete(): Boolean = throw SecurityException("test failure")
        }
        assertThrows(SecurityException::class.java) { deleteModelFile(denied) }
    }
}
