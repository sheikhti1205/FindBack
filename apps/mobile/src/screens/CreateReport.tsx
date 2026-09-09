import { useState } from "react";
import { useNavigate } from "react-router";
import { Camera, ImageUp, Sparkles, X } from "lucide-react";
import type { Category, PostType } from "@findback/shared";
import { useAuth } from "../auth";
import { Button } from "../components/Button";
import { TextField } from "../components/Fields";
import { Segmented } from "../components/Segmented";
import { CategoryField } from "../components/CategoryField";
import { LocationPicker, type LocationValue } from "../components/LocationPicker";
import { YouTubeEmbed } from "../components/YouTubeEmbed";
import { createPost, uploadImage, type StoredUpload } from "../services/posts";
import { suggestCategoryFromImage, type CategorySuggestion } from "../services/ml";
import { todayInputValue } from "../utils/dates";

const inputCls =
  "w-full rounded-m3-sm border border-outline-variant bg-surface px-3.5 py-3 text-base placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none";

export function CreateReport() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [type, setType] = useState<PostType>("LOST");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<Category | "">("");
  const [eventDate, setEventDate] = useState(todayInputValue());
  const [location, setLocation] = useState<LocationValue>({
    label: "",
    latitude: null,
    longitude: null,
  });
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [upload, setUpload] = useState<StoredUpload | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestion, setSuggestion] = useState<CategorySuggestion | null>(null);
  const [mlError, setMlError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onPickImage(file: File | undefined) {
    if (!file) return;
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(URL.createObjectURL(file));
    setSuggestion(null);
    setUploading(true);
    setMlError(null);
    try {
      const stored = await uploadImage(file);
      setUpload(stored);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function onSuggestCategory() {
    setSuggesting(true);
    setMlError(null);
    try {
      if (!upload) throw new Error("Upload an image first");
      const file = await blobFromUrl(upload.fileUrl);
      const result = await suggestCategoryFromImage(file);
      if (result) setSuggestion(result);
      else setMlError("Could not recognize the image — choose manually.");
    } catch (e) {
      setMlError(e instanceof Error ? e.message : "ML is unavailable right now.");
    } finally {
      setSuggesting(false);
    }
  }

  function applySuggestion() {
    if (suggestion && suggestion.category !== "Other") {
      setCategory(suggestion.category);
      setSuggestion(null);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!title.trim() || !description.trim() || !category) {
      setError("Title, description and category are required.");
      return;
    }
    setBusy(true);
    try {
      const post = await createPost({
        type,
        title: title.trim(),
        description: description.trim(),
        category,
        eventDate,
        locationLabel: location.label.trim() || undefined,
        latitude: location.latitude,
        longitude: location.longitude,
        youtubeUrl: youtubeUrl.trim() || undefined,
        attachmentKey: upload?.id,
      });
      navigate(`/posts/${post.id}`, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not publish");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5 px-4 py-5" noValidate>
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Report an item</h1>
        <p className="text-sm text-on-surface-variant">
          Posting as @{user?.username}. Be specific — details help reunions.
        </p>
      </header>

      {error && (
        <p className="rounded-m3-sm border border-error px-3 py-2 text-sm text-error" role="alert">
          {error}
        </p>
      )}

      <Segmented<PostType>
        ariaLabel="Lost or found"
        value={type}
        onChange={setType}
        options={[
          { value: "LOST", label: "I lost something" },
          { value: "FOUND", label: "I found something" },
        ]}
      />

      <TextField
        label={type === "LOST" ? "What did you lose?" : "What did you find?"}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="e.g. Scientific calculator near the Science Faculty"
        required
      />

      <label className="block">
        <span className="mb-1 block text-sm font-medium">Description</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={4}
          placeholder="Colour, brand, markings, when and where it happened…"
          className={inputCls}
          required
        />
      </label>

      <CategoryField value={category} onChange={setCategory} />

      <label className="block">
        <span className="mb-1 block text-sm font-medium">
          {type === "LOST" ? "Date lost" : "Date found"}
        </span>
        <input
          type="date"
          value={eventDate}
          onChange={(e) => setEventDate(e.target.value)}
          className={inputCls}
          required
        />
      </label>

      <LocationPicker value={location} onChange={setLocation} />

      {/* Photo + optional on-device ML category suggestion */}
      <section className="flex flex-col gap-3 rounded-m3-md border border-outline-variant p-3">
        <p className="text-sm font-medium">Photo (optional)</p>
        {previewUrl ? (
          <div className="relative">
            <img src={previewUrl} alt="Attachment preview" className="max-h-56 w-full rounded-m3-sm border border-outline-variant object-cover" />
            <button
              type="button"
              aria-label="Remove photo"
              onClick={() => {
                URL.revokeObjectURL(previewUrl);
                setPreviewUrl(null);
                setUpload(null);
                setSuggestion(null);
              }}
              className="absolute right-2 top-2 rounded-full bg-surface/90 p-1.5 text-on-surface shadow"
            >
              <X size={16} />
            </button>
          </div>
        ) : (
          <label className="flex min-h-[120px] cursor-pointer flex-col items-center justify-center gap-2 rounded-m3-sm border border-dashed border-outline px-4 text-center text-sm text-on-surface-variant hover:bg-surface-container">
            <ImageUp size={22} aria-hidden />
            {uploading ? "Uploading…" : "Tap to choose an image"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="sr-only"
              onChange={(e) => onPickImage(e.target.files?.[0])}
            />
          </label>
        )}

        {upload && (
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="md" loading={suggesting} onClick={onSuggestCategory}>
              <Sparkles size={16} aria-hidden />
              Suggest category (on-device ML)
            </Button>
            {suggestion && (
              <span className="flex items-center gap-2 rounded-full border border-outline px-3 py-1 text-sm">
                <Camera size={14} aria-hidden />
                {suggestion.category} · {(suggestion.confidence * 100).toFixed(0)}%
                {suggestion.category !== "Other" && (
                  <button type="button" onClick={applySuggestion} className="font-semibold underline">
                    Use
                  </button>
                )}
              </span>
            )}
          </div>
        )}
        {mlError && <p className="text-xs text-error">{mlError}</p>}
        <p className="text-[11px] text-on-surface-variant">
          Runs locally on this device (TensorFlow.js). You can always pick the category yourself.
        </p>
      </section>

      {/* Optional external YouTube media */}
      <label className="block">
        <span className="mb-1 block text-sm font-medium">YouTube link (optional)</span>
        <input
          type="url"
          value={youtubeUrl}
          onChange={(e) => setYoutubeUrl(e.target.value)}
          placeholder="https://www.youtube.com/watch?v=…"
          className={inputCls}
        />
      </label>
      {youtubeUrl.trim() && <YouTubeEmbed url={youtubeUrl.trim()} />}

      <Button type="submit" size="lg" loading={busy}>
        Publish {type === "LOST" ? "lost" : "found"} report
      </Button>
    </form>
  );
}

async function blobFromUrl(url: string): Promise<File> {
  const res = await fetch(url);
  const blob = await res.blob();
  const name = url.split("/").pop() ?? "photo.jpg";
  const mime = blob.type || "image/jpeg";
  return new File([blob], name, { type: mime });
}
