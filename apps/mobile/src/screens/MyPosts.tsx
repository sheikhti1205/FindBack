import { useEffect, useState } from "react";
import type { PostItem } from "@findback/shared";
import { fetchMyPosts } from "../services/posts";
import { PostCard } from "../components/PostCard";
import { PostCardContent } from "../components/PostCardContent";
import { EmptyState, Spinner } from "../components/PostCard";
import { FileQuestion } from "lucide-react";

export function MyPosts() {
  const [items, setItems] = useState<PostItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchMyPosts()
      .then((page) => setItems(page.items))
      .catch((e) => setError(e instanceof Error ? e.message : "Could not load your reports"));
  }, []);

  return (
    <div className="flex flex-col gap-4 py-5">
      <header className="px-4">
        <h1 className="text-xl font-semibold tracking-tight">My reports</h1>
        <p className="text-sm text-on-surface-variant">
          Manage the status of items you have reported.
        </p>
      </header>

      {items === null && !error && <Spinner label="Loading your reports…" />}
      {error && <EmptyState icon={<FileQuestion size={28} />} title="Could not load" subtitle={error} />}
      {items && items.length === 0 && (
        <EmptyState icon={<FileQuestion size={28} />} title="You have no reports yet" subtitle="Tap Report to post a lost or found item." />
      )}
      {items && items.length > 0 && (
        <div className="flex flex-col gap-3 px-4">
          {items.map((post, i) => (
            <PostCard key={post.id} to={`/posts/${post.id}`} index={i}>
              <PostCardContent post={post} />
            </PostCard>
          ))}
        </div>
      )}
    </div>
  );
}
