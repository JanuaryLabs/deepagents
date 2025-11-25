import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// ============================================================================
// Types
// ============================================================================

export type UserProfileItem = {
  type: 'fact' | 'preference' | 'present';
  text: string;
};

export type UserProfileData = {
  items: UserProfileItem[];
  lastUpdated: string;
};

// ============================================================================
// Store Implementation
// ============================================================================

export class UserProfileStore {
  private path: string;

  constructor(private userId: string) {
    // Sanitize userId to be safe for filenames
    const safeUserId = userId.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    this.path = path.join(tmpdir(), `user-profile-${safeUserId}.json`);
  }

  /**
   * Retrieve the full user profile data.
   */
  async get(): Promise<UserProfileData> {
    if (existsSync(this.path)) {
      try {
        const content = await readFile(this.path, 'utf-8');
        return JSON.parse(content);
      } catch (error) {
        console.error('Failed to read user profile:', error);
      }
    }

    // Default empty profile
    return {
      items: [],
      lastUpdated: new Date().toISOString(),
    };
  }

  /**
   * Save the user profile data.
   */
  private async save(data: UserProfileData): Promise<void> {
    data.lastUpdated = new Date().toISOString();
    await writeFile(this.path, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Add an item to the profile.
   */
  async add(type: UserProfileItem['type'], text: string): Promise<void> {
    const data = await this.get();

    // Check for exact duplicates
    const exists = data.items.some(
      (item) => item.type === type && item.text === text,
    );

    if (!exists) {
      data.items.push({ type, text });
      await this.save(data);
    }
  }

  /**
   * Remove a specific item from the profile.
   */
  async remove(type: UserProfileItem['type'], text: string): Promise<void> {
    const data = await this.get();

    const filtered = data.items.filter((item) => {
      return !(item.type === type && item.text === text);
    });

    await this.save({ ...data, items: filtered });
  }

  /**
   * Clear the entire profile.
   */
  async clear(): Promise<void> {
    await this.save({ items: [], lastUpdated: new Date().toISOString() });
  }

  /**
   * Get the formatted XML string for the system prompt.
   */
  async toXml(): Promise<string> {
    const data = await this.get();
    return toUserProfileXml(data.items);
  }
}

// ============================================================================
// Formatter
// ============================================================================

export function toUserProfileXml(items: UserProfileItem[]): string {
  if (items.length === 0) {
    return '';
  }

  const facts = items.filter((i) => i.type === 'fact');
  const preferences = items.filter((i) => i.type === 'preference');
  const present = items.filter((i) => i.type === 'present');

  const sections: string[] = [];

  // 1. Identity Section
  if (facts.length > 0) {
    const lines = facts.map((f) => `- ${f.text}`);
    sections.push(wrapBlock('identity', lines));
  }

  // 2. Preferences Section
  if (preferences.length > 0) {
    const lines = preferences.map((p) => `- ${p.text}`);
    sections.push(wrapBlock('preferences', lines));
  }

  // 3. Working Context Section
  if (present.length > 0) {
    const lines = present.map((c) => `- ${c.text}`);
    sections.push(wrapBlock('working_context', lines));
  }

  if (sections.length === 0) return '';

  return `<user_profile>\n${indentBlock(sections.join('\n'), 2)}\n</user_profile>`;
}

// ============================================================================
// Helpers
// ============================================================================

function wrapBlock(tag: string, lines: string[]): string {
  if (lines.length === 0) return '';
  return `<${tag}>\n${indentBlock(lines.join('\n'), 2)}\n</${tag}>`;
}

function indentBlock(text: string, spaces: number): string {
  const padding = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line.length ? padding + line : padding))
    .join('\n');
}
