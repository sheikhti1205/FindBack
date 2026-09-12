import type { Category, PostStatus, PostType } from "@findback/shared";
import { get, run } from "../db/index.js";
import { hashPassword } from "../domain/authService.js";
import { newId, nowIso } from "../domain/helpers.js";

/**
 * Realistic fictional University of Chittagong demo data. No real personal data.
 * Reused by tests with NODE_ENV=test and by `npm run seed`.
 */
export async function seedDatabase(): Promise<void> {
  const existing = await get<{ c: number }>("SELECT COUNT(*) AS c FROM users");
  if (existing && Number(existing.c) > 0) return;

  const now = nowIso();
  const users = [
    { username: "rafi_cu", email: "rafi@example.com", phone: "+8801810000001" },
    { username: "nusrat", email: "nusrat@example.com", phone: "+8801810000002" },
    { username: "tanvir_ce", email: "tanvir@example.com", phone: "+8801810000003" },
    { username: "shimu", email: "shimu@example.com", phone: "+8801810000004" },
    { username: "arif_cse", email: "arif@example.com", phone: "+8801810000005" },
    { username: "mitu", email: "mitu@example.com", phone: "+8801810000006" },
    { username: "sayeed_bsc", email: "sayeed@example.com", phone: "+8801810000007" },
    { username: "priya", email: "priya@example.com", phone: "+8801810000008" },
  ];
  const hash = await hashPassword("password123");

  const userIds: Record<string, string> = {};
  for (const u of users) {
    const id = newId();
    await run(
      `INSERT INTO users (id, username, email, phone, password_hash, email_verified, phone_verified, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`,
      [id, u.username, u.email, u.phone, hash, now, now],
    );
    userIds[u.username] = id;
  }

  const d = (daysAgo: number) => {
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    return date;
  };
  const iso = (date: Date) => date.toISOString();
  const day = (date: Date) => date.toISOString().slice(0, 10);

  interface SeedPost {
    author: string;
    type: PostType;
    title: string;
    description: string;
    category: Category;
    status: PostStatus;
    eventDate: Date;
    lat?: number;
    lng?: number;
    locationLabel?: string;
    createdAt: Date;
  }
  const posts: SeedPost[] = [
    {
      author: "rafi_cu", type: "LOST", title: "Scientific calculator lost near Science Faculty",
      description: "Casio fx-991EX, blue, lost in the Science Faculty corridor around 11am. Reward offered.",
      category: "Electronics", status: "OPEN", eventDate: d(1), createdAt: d(1),
      lat: 22.4688, lng: 91.7835, locationLabel: "Science Faculty, University of Chittagong",
    },
    {
      author: "nusrat", type: "FOUND", title: "Student ID card found near Zero Point",
      description: "ID card found near the Zero Point gate. Handed it to the campus security office.",
      category: "Documents & IDs", status: "OPEN", eventDate: d(0), createdAt: d(0),
      lat: 22.4695, lng: 91.7891, locationLabel: "Zero Point, University of Chittagong",
    },
    {
      author: "tanvir_ce", type: "FOUND", title: "Black umbrella found near Central Library",
      description: "A black foldable umbrella was left on a bench near the Central Library entrance.",
      category: "Clothing", status: "OPEN", eventDate: d(0), createdAt: d(0),
      lat: 22.4671, lng: 91.7868, locationLabel: "Central Library",
    },
    {
      author: "shimu", type: "LOST", title: "Wallet lost near Shahid Minar area",
      description: "Brown leather wallet with a few cards and a bus pass. Please contact if found.",
      category: "Bags & Wallets", status: "OPEN", eventDate: d(2), createdAt: d(2),
      lat: 22.4663, lng: 91.7821, locationLabel: "Shahid Minar, University of Chittagong",
    },
    {
      author: "arif_cse", type: "LOST", title: "Blue backpack left in CSE lab 4",
      description: "Blue backpack with a laptop charger and notebook left in CSE building lab 4.",
      category: "Bags & Wallets", status: "MATCHED", eventDate: d(3), createdAt: d(3),
      lat: 22.4702, lng: 91.7861, locationLabel: "CSE Building",
    },
    {
      author: "mitu", type: "FOUND", title: "Keys with a small torch found at the canteen",
      description: "A set of keys (two door keys + a torch keychain) found at the faculty canteen.",
      category: "Keys", status: "OPEN", eventDate: d(1), createdAt: d(1),
      lat: 22.4681, lng: 91.7844, locationLabel: "Faculty Canteen",
    },
    {
      author: "sayeed_bsc", type: "LOST", title: "English novel lost on the library lawn",
      description: "A worn copy of 'The Old Man and the Sea' left on the grass near the library.",
      category: "Books & Stationery", status: "CLOSED", eventDate: d(4), createdAt: d(4),
      lat: 22.4673, lng: 91.7865, locationLabel: "Library Lawn",
    },
    {
      author: "priya", type: "FOUND", title: "Silver earring found near the girls' common room",
      description: "A small silver stud earring found on the steps outside the girls' common room.",
      category: "Accessories & Jewelry", status: "OPEN", eventDate: d(0), createdAt: d(0),
      lat: 22.4659, lng: 91.7832, locationLabel: "Girls' Common Room",
    },
    {
      author: "nusrat", type: "FOUND", title: "Earbuds found in the bus from campus",
      description: "White wireless earbuds found on the seat of the campus shuttle this morning.",
      category: "Electronics", status: "OPEN", eventDate: d(0), createdAt: d(0),
      lat: 22.4698, lng: 91.7809, locationLabel: "Campus Shuttle",
    },
    {
      author: "rafi_cu", type: "LOST", title: "Umbrella with a blue handle",
      description: "Blue-handled umbrella possibly left at the Business Faculty entry.",
      category: "Clothing", status: "OPEN", eventDate: d(5), createdAt: d(5),
    },
    {
      author: "arif_cse", type: "FOUND", title: "Notebook found near the volleyball court",
      description: "A spiral notebook with math notes found near the volleyball court.",
      category: "Books & Stationery", status: "OPEN", eventDate: d(2), createdAt: d(2),
    },
    {
      author: "shimu", type: "LOST", title: "Grey hoodie left in the exam hall",
      description: "Grey hoodie left under the seat in the second-year exam hall.",
      category: "Clothing", status: "RECOVERED", eventDate: d(6), createdAt: d(6),
    },
    {
      author: "mitu", type: "FOUND", title: "Power bank found in the library",
      description: "Black 10000mAh power bank found on a reading table, third floor.",
      category: "Electronics", status: "OPEN", eventDate: d(1), createdAt: d(1),
    },
    {
      author: "tanvir_ce", type: "LOST", title: "Water bottle with stickers",
      description: "Silver bottle covered in stickers, last seen at the gymnasium.",
      category: "Other", status: "OPEN", eventDate: d(2), createdAt: d(2),
    },
    {
      author: "priya", type: "FOUND", title: "Prescription glasses found on campus road",
      description: "Black-framed glasses found near the main road opposite the Science Faculty.",
      category: "Accessories & Jewelry", status: "OPEN", eventDate: d(0), createdAt: d(0),
    },
  ];

  const postIds: string[] = [];
  const reactionPool = ["LIKE", "DISLIKE"] as const;
  for (const p of posts) {
    const id = newId();
    const created = iso(p.createdAt);
    await run(
      `INSERT INTO item_posts
         (id, user_id, type, title, description, category, status, event_date,
          latitude, longitude, location_label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, userIds[p.author]!, p.type, p.title, p.description, p.category, p.status,
        day(p.eventDate), p.lat ?? null, p.lng ?? null, p.locationLabel ?? null, created, created,
      ],
    );
    postIds.push(id);
  }

  // Deterministic-ish pseudo-random comments, reactions and ratings
  let idx = 0;
  const commentLines = [
    "Is it still at the security office? I think it might be mine!",
    "Please check your inbox, I messaged you about this.",
    "Thanks for posting this, I've asked around my friends.",
    "Have you tried asking the faculty office?",
    "I saw something similar yesterday near the same spot.",
    "Marking this for my batch group so more people see it.",
    "Hope you find it soon!",
    "I left a note at the notice board about this.",
  ];
  for (const postId of postIds) {
    const commentCount = 1 + (idx % 3);
    for (let c = 0; c < commentCount; c++) {
      const author = users[(idx + c + 1) % users.length]!.username;
      await run(
        `INSERT INTO comments (id, post_id, user_id, body, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [newId(), postId, userIds[author]!, commentLines[(idx + c) % commentLines.length]!, iso(d(idx % 6)), iso(d(idx % 6))],
      );
    }
    const likeCount = (idx * 3) % 6;
    for (let r = 0; r < likeCount; r++) {
      const author = users[(idx + r) % users.length]!.username;
      await run(
        `INSERT INTO reactions (id, post_id, user_id, type, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        [newId(), postId, userIds[author]!, reactionPool[r % 2], iso(d(idx % 6))],
      );
    }
    const ratingCount = (idx * 2) % 4;
    for (let r = 0; r < ratingCount; r++) {
      const author = users[(idx + r + 2) % users.length]!.username;
      const score = 3 + ((idx + r) % 3);
      const created = iso(d(idx % 6));
      await run(
        `INSERT INTO ratings (id, post_id, user_id, score, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [newId(), postId, userIds[author]!, score, created, created],
      );
    }
    idx++;
  }
}
