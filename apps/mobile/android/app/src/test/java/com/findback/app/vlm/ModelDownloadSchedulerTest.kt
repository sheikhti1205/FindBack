package com.findback.app.vlm

import androidx.work.NetworkType
import kotlin.test.Test
import kotlin.test.assertEquals

class ModelDownloadSchedulerTest {

    @Test fun wifiOnlyMapsToUnmeteredWorkerConstraint() {
        assertEquals(
            NetworkType.UNMETERED,
            ModelDownloadScheduler.workNetworkType(ModelDownloadScheduler.NetworkPolicy.WIFI_ONLY)
        )
    }

    @Test fun cellularOptInMapsToConnectedWorkerConstraint() {
        assertEquals(
            NetworkType.CONNECTED,
            ModelDownloadScheduler.workNetworkType(ModelDownloadScheduler.NetworkPolicy.WIFI_OR_CELLULAR)
        )
    }

    @Test fun stableJobIdsAndWorkNamesPerModel() {
        assertEquals(4101, ModelDownloadScheduler.jobIdFor(VlmModelId.SMOLVLM2_500M))
        assertEquals(4102, ModelDownloadScheduler.jobIdFor(VlmModelId.SMOLVLM_256M))
        assertEquals("findback-model-smolvlm2-500m", ModelDownloadScheduler.workNameFor(VlmModelId.SMOLVLM2_500M))
        assertEquals("findback-model-smolvlm-256m", ModelDownloadScheduler.workNameFor(VlmModelId.SMOLVLM_256M))
    }
}
