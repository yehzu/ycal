// yCal — glossary store hook.
//
// Owns the global glossary (cross-device via cloudStore + Drive sync) and
// exposes editing operations. Per-event overrides go through the same
// IPC but live in a separate file per event; callers that need them
// (TranscriptSheet) call the event-glossary methods directly.

import { useCallback, useEffect, useState } from 'react';
import type {
  AttendeeSuggestion, EventGlossary, GlossaryEntry, GlossaryFile,
} from '@shared/types';

export interface GlossaryStore {
  loading: boolean;
  file: GlossaryFile;
  refresh: () => Promise<void>;
  saveAll: (entries: GlossaryEntry[]) => Promise<void>;
  addEntry: (entry: Omit<GlossaryEntry, 'id' | 'addedAt'> & Partial<Pick<GlossaryEntry, 'id' | 'addedAt'>>) => Promise<GlossaryEntry | null>;
  updateEntry: (id: string, patch: Partial<GlossaryEntry>) => Promise<void>;
  deleteEntry: (id: string) => Promise<void>;
  importGlossary: (
    body: string, format?: 'json' | 'markdown' | 'csv' | 'auto',
  ) => Promise<{ parsed: number; added: number; updated: number } | { error: string }>;
  suggestAttendees: (lookBackDays?: number) => Promise<AttendeeSuggestion[]>;
  getEventGlossary: (eventId: string) => Promise<EventGlossary>;
  setEventGlossary: (
    eventId: string, accountId: string | null | undefined, entries: GlossaryEntry[],
  ) => Promise<EventGlossary | null>;
}

const EMPTY: GlossaryFile = { version: 1, entries: [], updatedAt: 0 };

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback — Math.random isn't crypto-strong but ids are stable per
  // entry and never need to be unpredictable.
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function useGlossary(): GlossaryStore {
  const [file, setFile] = useState<GlossaryFile>(EMPTY);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await window.ycal.glossaryGet();
      setFile(data);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unsub = window.ycal.onGlossaryChanged((next) => {
      setFile(next);
    });
    return unsub;
  }, [refresh]);

  const saveAll = useCallback(async (entries: GlossaryEntry[]) => {
    const result = await window.ycal.glossarySet(entries);
    if (result.ok) setFile(result.file);
  }, []);

  const addEntry = useCallback(async (
    input: Omit<GlossaryEntry, 'id' | 'addedAt'> & Partial<Pick<GlossaryEntry, 'id' | 'addedAt'>>,
  ): Promise<GlossaryEntry | null> => {
    const fresh: GlossaryEntry = {
      id: input.id ?? newId(),
      canonical: input.canonical.trim(),
      aliases: (input.aliases ?? []).map((a) => a.trim()).filter(Boolean),
      category: input.category ?? 'other',
      caseSensitive: !!input.caseSensitive,
      addedAt: input.addedAt ?? Date.now(),
      source: input.source ?? 'manual',
    };
    if (!fresh.canonical) return null;
    const next = [...file.entries, fresh];
    const result = await window.ycal.glossarySet(next);
    if (result.ok) {
      setFile(result.file);
      return fresh;
    }
    return null;
  }, [file]);

  const updateEntry = useCallback(async (id: string, patch: Partial<GlossaryEntry>) => {
    const next = file.entries.map((e) => {
      if (e.id !== id) return e;
      return {
        ...e,
        ...patch,
        canonical: typeof patch.canonical === 'string' ? patch.canonical.trim() : e.canonical,
        aliases: Array.isArray(patch.aliases)
          ? patch.aliases.map((a) => a.trim()).filter(Boolean)
          : e.aliases,
      };
    });
    const result = await window.ycal.glossarySet(next);
    if (result.ok) setFile(result.file);
  }, [file]);

  const deleteEntry = useCallback(async (id: string) => {
    const next = file.entries.filter((e) => e.id !== id);
    const result = await window.ycal.glossarySet(next);
    if (result.ok) setFile(result.file);
  }, [file]);

  const importGlossary = useCallback(async (
    body: string, format: 'json' | 'markdown' | 'csv' | 'auto' = 'auto',
  ) => {
    const result = await window.ycal.glossaryImport({ body, format });
    if (result.ok) {
      setFile(result.file);
      return { parsed: result.parsed, added: result.added, updated: result.updated };
    }
    return { error: result.error };
  }, []);

  const suggestAttendees = useCallback(async (lookBackDays = 60) => {
    const result = await window.ycal.glossarySuggestAttendees(lookBackDays);
    if (result.ok) return result.suggestions;
    return [];
  }, []);

  const getEventGlossary = useCallback(async (eventId: string): Promise<EventGlossary> => {
    const result = await window.ycal.eventGlossaryGet(eventId);
    if (result.ok) return result.glossary;
    return { eventId, entries: [] };
  }, []);

  const setEventGlossaryFn = useCallback(async (
    eventId: string,
    accountId: string | null | undefined,
    entries: GlossaryEntry[],
  ): Promise<EventGlossary | null> => {
    const result = await window.ycal.eventGlossarySet({ eventId, accountId, entries });
    if (result.ok) return result.glossary;
    return null;
  }, []);

  return {
    loading,
    file,
    refresh,
    saveAll,
    addEntry,
    updateEntry,
    deleteEntry,
    importGlossary,
    suggestAttendees,
    getEventGlossary,
    setEventGlossary: setEventGlossaryFn,
  };
}
