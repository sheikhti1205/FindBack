import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { ImageUp, X } from "lucide-react";
import type { Category, PostType } from "@findback/shared";
import { useAuth } from "../auth";
import { Button } from "../components/Button";
import { TextField } from "../components/Fields";
import { Segmented } from "../components/Segmented";
import { CategoryField } from "../components/CategoryField";
import { MarkdownComposer } from "../components/MarkdownComposer";
import { LocationPicker, type LocationValue } from "../components/LocationPicker";
import { YouTubeEmbed } from "../components/YouTubeEmbed";
import { VlmSuggestions } from "../components/VlmSuggestions";
import { announce } from "../components/LiveRegion";
import { publishReport } from "../services/posts";
import { clearDraft, draftIsMeaningful, loadDraft, saveDraft } from "../services/reportDraft";
import { friendlyError } from "../utils/friendlyErrors";
import { isNativeCameraAvailable, takePhoto, chooseFromGallery, photoToFile, toNativeImageUri, type PickedPhoto } from "../services/photo";
import { dropStashedPhoto, getStashedPhoto, stashPhotoFile } from "../services/photoStore";
import type { VlmAnalysis } from "../services/vlmParser";
import { todayInputValue, isFutureDate } from "../utils/dates";

const inputCls =
  "w-full rounded-m3-sm border border-outline-variant bg-surface px-3.5 py-3 text-base placeholder:text-on-surface-variant focus:border-on-surface focus:outline-none";

export function CreateReport() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [initialDraft] = useState(loadDraft);
  const [type, setType] = useState<PostType>(initialDraft?.type ?? "LOST");
  const [title, setTitle] = useState(initialDraft?.title ?? "");
  const [description, setDescription] = useState(initialDraft?.description ?? "");
  const [category, setCategory] = useState<Category | "">(initialDraft?.category ?? "");
  const [eventDate, setEventDate] = useState(initialDraft?.eventDate ?? todayInputValue());
  const [location, setLocation] = useState<LocationValue>(
    initialDraft?.location ?? {
      label: "",
      latitude: null,
      longitude: null,
    },
  );
  const [youtubeUrl, setYoutubeUrl] = useState(initialDraft?.youtubeUrl ?? "");
  const [photoId, setPhotoId] = useState<string | null>(initialDraft?.photoId ?? null);
  // A restored File keeps the draft publishable after a trip to another screen.
  const [selectedFile, setSelectedFile] = useState<File | null>(() =>
    getStashedPhoto(initialDraft?.photoId),
  );
  const [pickedPhoto, setPickedPhoto] = useState<PickedPhoto | null>(() => {
    const uri = initialDraft?.photoNativeUri;
    if (!uri || uri.startsWith("blob:")) return null;
    const web = initialDraft?.photoWebPath;
    return { nativeUri: uri, webPath: web && !web.startsWith("blob:") ? web : uri, format: initialDraft?.photoFormat ?? "jpg" };
  });
  const [previewUrl, setPreviewUrl] = useState<string | null>(() => {
    // A stashed File only has a blob URL, so rebuild one for the preview.
    const stashed = getStashedPhoto(initialDraft?.photoId);
    if (stashed && typeof URL !== "undefined" && URL.createObjectURL) {
      return URL.createObjectURL(stashed);
    }
    const web = initialDraft?.photoWebPath;
    return web && !web.startsWith("blob:") ? web : null;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{
    title?: string;
    description?: string;
    category?: string;
    eventDate?: string;
  }>({});
  const submitting = useRef(false);

  // Restore the uploadable File for a draft whose photo came from the native
  // camera/gallery, where only a native URI survives in the draft.
  const initialPhotoRef = useRef(pickedPhoto);
  useEffect(() => {
    const photo = initialPhotoRef.current;
    if (!photo || selectedFile) return;
    let cancelled = false;
    void photoToFile(photo)
      .then((file) => {
        if (!cancelled) setSelectedFile(file);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  // Preserve the draft across in-app navigation (Help, map helper, model setup).
  useEffect(() => {
    saveDraft({
      type,
      title,
      description,
      category,
      eventDate,
      location,
      youtubeUrl,
      photoId,
      photoNativeUri: pickedPhoto?.nativeUri ?? null,
      photoWebPath: pickedPhoto?.webPath ?? previewUrl,
      photoFormat: pickedPhoto?.format ?? null,
    });
  }, [type, title, description, category, eventDate, location, youtubeUrl, photoId, pickedPhoto, previewUrl]);

  function discardDraft() {
    const current = { type, title, description, category, eventDate, location, youtubeUrl };
    if (!draftIsMeaningful(current) && !pickedPhoto && !selectedFile) return;
    if (!window.confirm("Discard this report and clear the selected photo?")) return;
    clearDraft();
    setType("LOST");
    setTitle("");
    setDescription("");
    setCategory("");
    setEventDate(todayInputValue());
    setLocation({ label: "", latitude: null, longitude: null });
    setYoutubeUrl("");
    clearPhoto();
    announce("Report draft discarded.");
  }

  function onPickImage(file: File | undefined, photo?: PickedPhoto) {
    if (!file) return;
    if (previewUrl && previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    dropStashedPhoto(photoId);
    const id = stashPhotoFile(file);
    setPhotoId(id);
    setSelectedFile(file);
    if (photo?.nativeUri && !photo.nativeUri.startsWith("blob:")) {
      setPickedPhoto(photo);
      setPreviewUrl(photo.webPath);
    } else {
      setPickedPhoto(null);
      setPreviewUrl(URL.createObjectURL(file));
    }
    setError(null);
  }

  function clearPhoto() {
    if (previewUrl && previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
    dropStashedPhoto(photoId);
    setPhotoId(null);
    setPreviewUrl(null);
    setSelectedFile(null);
    setPickedPhoto(null);
  }

  function applyVlmSuggestion(patch: Partial<VlmAnalysis>) {
    if (patch.suggestedTitle !== undefined) setTitle(patch.suggestedTitle ?? "");
    if (patch.suggestedDescription !== undefined) setDescription(patch.suggestedDescription ?? "");
    if (patch.suggestedCategory !== undefined && patch.suggestedCategory !== null) setCategory(patch.suggestedCategory);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting.current) return;
    setError(null);
    const errs = {
      title: title.trim() ? undefined : "Enter a short title.",
      description: description.trim() ? undefined : "Describe the item so it can be recognised.",
      category: category ? undefined : "Choose a category.",
      eventDate: isFutureDate(eventDate) ? "The date can't be in the future." : undefined,
    };
    setFieldErrors(errs);
    // `!category` also narrows the type for publishReport below.
    if (errs.title || errs.description || errs.category || errs.eventDate || !category) return;
    submitting.current = true;
    setBusy(true);
    try {
      const postId = await publishReport(
        {
          type,
          title: title.trim(),
          description: description.trim(),
          category,
          eventDate,
          locationLabel: location.label.trim() || undefined,
          latitude: location.latitude,
          longitude: location.longitude,
          youtubeUrl: youtubeUrl.trim() || undefined,
        },
        selectedFile,
      );
      clearDraft();
      if (previewUrl && previewUrl.startsWith("blob:")) URL.revokeObjectURL(previewUrl);
      dropStashedPhoto(photoId);
      setPhotoId(null);
      setPreviewUrl(null);
      setSelectedFile(null);
      setPickedPhoto(null);
      announce("Report published.");
      navigate(`/posts/${postId}`, { replace: true });
    } catch (err) {
      setError(friendlyError(err).message);
    } finally {
      submitting.current = false;
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
        onChange={(e) => {
          setTitle(e.target.value);
          if (fieldErrors.title) setFieldErrors((f) => ({ ...f, title: undefined }));
        }}
        placeholder="e.g. Scientific calculator near the Science Faculty"
        error={fieldErrors.title}
        required
      />

      <MarkdownComposer
        label="Description"
        value={description}
        onChange={(v) => {
          setDescription(v);
          if (fieldErrors.description) setFieldErrors((f) => ({ ...f, description: undefined }));
        }}
        placeholder="Colour, brand, markings, when and where it happened…"
        error={fieldErrors.description}
        required
      />

      <CategoryField
        value={category}
        onChange={(c) => {
          setCategory(c);
          if (fieldErrors.category) setFieldErrors((f) => ({ ...f, category: undefined }));
        }}
        error={fieldErrors.category}
      />

      <label className="block">
        <span className="mb-1 block text-sm font-medium">
          {type === "LOST" ? "Date lost" : "Date found"}
        </span>
        <input
          type="date"
          value={eventDate}
          max={todayInputValue()}
          onChange={(e) => setEventDate(e.target.value)}
          className={inputCls}
          required
        />
        {isFutureDate(eventDate) && (
          <span className="mt-1 block text-xs text-error">
            The date can't be in the future.
          </span>
        )}
      </label>

      <LocationPicker value={location} onChange={setLocation} />

      {/* Photo (optional) */}
      <section className="flex flex-col gap-3 rounded-m3-md border border-outline-variant p-3">
        <p className="text-sm font-medium">Photo (optional)</p>
        {previewUrl ? (
          <div className="relative">
            <img src={previewUrl} alt="Attachment preview" className="max-h-56 w-full rounded-m3-sm border border-outline-variant object-cover" />
            <button
              type="button"
              aria-label="Remove photo"
              onClick={clearPhoto}
              className="absolute right-2 top-2 flex min-h-[48px] min-w-[48px] items-center justify-center rounded-full bg-surface/90 text-on-surface shadow"
            >
              <X size={16} />
            </button>
          </div>
        ) : (
          <>
            {isNativeCameraAvailable() && (
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="md"
                  onClick={async () => {
                    const picked = await takePhoto();
                    if (picked) {
                      const file = await photoToFile(picked);
                      onPickImage(file, picked);
                    }
                  }}
                >
                  <ImageUp size={18} aria-hidden />
                  Take photo
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="md"
                  onClick={async () => {
                    const picked = await chooseFromGallery();
                    if (picked) {
                      const file = await photoToFile(picked);
                      onPickImage(file, picked);
                    }
                  }}
                >
                  <ImageUp size={18} aria-hidden />
                  Choose from gallery
                </Button>
              </div>
            )}
            <label className="flex min-h-[120px] cursor-pointer flex-col items-center justify-center gap-2 rounded-m3-sm border border-dashed border-outline px-4 text-center text-sm text-on-surface-variant hover:bg-surface-container">
              <ImageUp size={22} aria-hidden />
              {isNativeCameraAvailable() ? "Or tap to choose a file" : "Tap to choose an image"}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="sr-only"
                onChange={(e) => onPickImage(e.target.files?.[0])}
              />
            </label>
          </>
        )}
      </section>

      {/* Local VLM report assistant — only on Android with native camera */}
      {isNativeCameraAvailable() && pickedPhoto && toNativeImageUri(pickedPhoto) && (
        <VlmSuggestions imageUri={toNativeImageUri(pickedPhoto)!} onApply={applyVlmSuggestion} />
      )}
      {isNativeCameraAvailable() && pickedPhoto && !toNativeImageUri(pickedPhoto) && (
        <Button
          type="button"
          variant="outline"
          size="md"
          onClick={() => {
            saveDraft({
              type,
              title,
              description,
              category,
              eventDate,
              location,
              youtubeUrl,
              photoId,
              photoNativeUri: pickedPhoto?.nativeUri ?? null,
              photoWebPath: pickedPhoto?.webPath ?? previewUrl,
              photoFormat: pickedPhoto?.format ?? null,
            });
            navigate("/offline-ai");
          }}
        >
          Download model
        </Button>
      )}

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
      <Button type="button" variant="text" size="md" onClick={discardDraft}>
        Discard draft
      </Button>
    </form>
  );
}
