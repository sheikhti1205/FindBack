package com.findback.app;

import static org.junit.Assert.assertEquals;

import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException;
import androidx.credentials.exceptions.GetCredentialUnsupportedException;
import androidx.credentials.exceptions.NoCredentialException;
import java.lang.reflect.Method;
import org.junit.Test;

/** Tests the actual bridge classification, not a duplicate retry policy. */
public class GoogleAuthClassificationTest {
    private static String kind(GetCredentialException error) throws Exception {
        Method classifier = GoogleAuthPlugin.class.getDeclaredMethod("kindFor", GetCredentialException.class);
        classifier.setAccessible(true);
        return (String) classifier.invoke(null, error);
    }

    @Test public void onlyNoCredentialProducesTheBoundedFallbackSignal() throws Exception {
        assertEquals("no_credential", kind(new NoCredentialException("ignored")));
        assertEquals("unavailable", kind(new GetCredentialUnsupportedException("ignored")));
        assertEquals("cancelled", kind(new GetCredentialCancellationException("ignored")));
        assertEquals("misconfigured", kind(new GetCredentialProviderConfigurationException("ignored")));
    }
}
