package com.findback.app.media;

import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

/** Pure request ownership model. All transitions serialize on the process-local registry. */
public final class MediaRequestState {
    public enum Phase { PICKING, PROCESSING }
    public static final class Request {
        public final String id, source;
        private Phase phase;
        public volatile boolean cancelled;
        private Request(String id, String source, Phase phase) { this.id = id; this.source = source; this.phase = phase; }
    }
    public static final class Snapshot {
        public final String id, source;
        public final Phase phase;
        public Snapshot(String id, String source, Phase phase) { this.id = id; this.source = source; this.phase = phase; }
    }
    public static final class Registry {
        private final Map<String, Entry> live = new HashMap<>();
        // Prevent stale saved picker snapshots from resurrecting finished in-process work.
        private final Set<String> completed = new LinkedHashSet<>();
    }
    private static final class Entry {
        final Request request;
        MediaRequestState owner;
        Entry(Request request, MediaRequestState owner) { this.request = request; this.owner = owner; }
    }
    private final Registry registry;
    private Request current;
    public MediaRequestState(Registry registry) { this.registry = registry; }
    public Request begin(String source, Phase phase) {
        synchronized (registry) {
            if (isBusy()) throw new IllegalStateException("Media busy");
            current = new Request(UUID.randomUUID().toString(), source, phase);
            registry.live.put(current.id, new Entry(current, this));
            return current;
        }
    }
    public Request current() { synchronized (registry) { return isBusy() ? current : null; } }
    public boolean isBusy() {
        synchronized (registry) {
            Entry entry = current == null ? null : registry.live.get(current.id);
            return entry != null && entry.owner == this && !current.cancelled;
        }
    }
    public boolean owns(String id, Phase phase) {
        synchronized (registry) { return isBusy() && current.id.equals(id) && current.phase == phase; }
    }
    public void processing(Request request) {
        synchronized (registry) {
            if (!owns(request.id, Phase.PICKING)) throw new IllegalStateException("Stale media picker");
            request.phase = Phase.PROCESSING;
        }
    }
    public Snapshot snapshot() {
        synchronized (registry) { return isBusy() ? new Snapshot(current.id, current.source, current.phase) : null; }
    }
    /** Returns only a process-death PROCESSING id whose abandoned directory may be reclaimed. */
    public String restore(Snapshot snapshot) {
        synchronized (registry) {
            if (snapshot == null || snapshot.id == null || !snapshot.id.matches("[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}") || snapshot.phase == null) return null;
            if (!("photos".equals(snapshot.source) || "files".equals(snapshot.source) || "camera".equals(snapshot.source) || "uri".equals(snapshot.source))) return null;
            if (registry.completed.contains(snapshot.id)) return null;
            Entry entry = registry.live.get(snapshot.id);
            if (snapshot.phase == Phase.PROCESSING || entry != null && entry.request.phase == Phase.PROCESSING) {
                if (entry != null) entry.request.cancelled = true;
                // A live worker retains both its old owner and final cleanup responsibility.
                return entry == null ? snapshot.id : null;
            }
            if (entry == null) {
                Request request = new Request(snapshot.id, snapshot.source, Phase.PICKING);
                entry = new Entry(request, this);
                registry.live.put(snapshot.id, entry);
            } else entry.owner = this;
            current = entry.request;
            return null;
        }
    }
    /** Only the current cleanup owner can release a request. Never clears a newer request. */
    public boolean finish(Request request) {
        synchronized (registry) {
            if (request == null) return false;
            Entry entry = registry.live.get(request.id);
            if (entry == null || entry.owner != this || entry.request != request) return false;
            registry.live.remove(request.id);
            registry.completed.add(request.id);
            if (registry.completed.size() > 128) registry.completed.remove(registry.completed.iterator().next());
            if (current == request) current = null;
            return true;
        }
    }
}
