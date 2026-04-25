'use client';

/**
 * Anthill collaborative editor.
 *
 * Plate (v53) + Yjs via Hocuspocus. One Yjs document per `documents.id`.
 *
 * - Renders the existing shadcn-style Plate node UI from `components/ui/*-node`.
 * - Connects via `@platejs/yjs` to the standalone Hocuspocus server in /collab.
 * - Persists Yjs binary updates server-side (in `documents.yjs_state`); the
 *   client never writes to Supabase directly while collab is active — all
 *   writes flow through the Yjs awareness/CRDT.
 * - Renders remote cursors via `RemoteCursorOverlay` and live presence
 *   avatars via `PresenceStack`.
 *
 * The `userId` prop gates collab: pass it for live sync, omit for solo / SSR.
 */

import {
  BlockquotePlugin,
  BoldPlugin,
  CodePlugin,
  H1Plugin,
  H2Plugin,
  H3Plugin,
  H4Plugin,
  H5Plugin,
  H6Plugin,
  HighlightPlugin,
  HorizontalRulePlugin,
  ItalicPlugin,
  KbdPlugin,
  StrikethroughPlugin,
  SubscriptPlugin,
  SuperscriptPlugin,
  UnderlinePlugin,
} from '@platejs/basic-nodes/react';
import {
  FontFamilyPlugin,
  FontSizePlugin,
  TextAlignPlugin,
} from '@platejs/basic-styles/react';
import {
  CodeBlockPlugin,
  CodeLinePlugin,
  CodeSyntaxPlugin,
} from '@platejs/code-block/react';
import { IndentPlugin } from '@platejs/indent/react';
import { LinkPlugin } from '@platejs/link/react';
import { ListPlugin } from '@platejs/list/react';
import { TrailingBlockPlugin } from '@platejs/utils';
import { YjsPlugin } from '@platejs/yjs/react';
import { all, createLowlight } from 'lowlight';
import type { Value } from 'platejs';
import { KEYS } from 'platejs';
import {
  ParagraphPlugin,
  Plate,
  usePlateEditor,
} from 'platejs/react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { AutoformatKit } from '@/components/editor/plugins/autoformat-kit';
import { MarkdownKit } from '@/components/editor/plugins/markdown-kit';
import { EditorToolbar } from '@/components/editor/editor-toolbar';
import { PresenceStack } from '@/components/editor/presence-stack';
import { RemoteCursorOverlay } from '@/components/editor/remote-cursor-overlay';
import { BlockquoteElement } from '@/components/ui/blockquote-node';
import {
  CodeBlockElement,
  CodeLineElement,
  CodeSyntaxLeaf,
} from '@/components/ui/code-block-node';
import { CodeLeaf } from '@/components/ui/code-node';
import { Editor, EditorContainer } from '@/components/ui/editor';
import {
  H1Element,
  H2Element,
  H3Element,
  H4Element,
  H5Element,
  H6Element,
} from '@/components/ui/heading-node';
import { HighlightLeaf } from '@/components/ui/highlight-node';
import { HrElement } from '@/components/ui/hr-node';
import { KbdLeaf } from '@/components/ui/kbd-node';
import { LinkElement } from '@/components/ui/link-node';
import { LinkFloatingToolbar } from '@/components/ui/link-toolbar';
import { ParagraphElement } from '@/components/ui/paragraph-node';
import { cursorColorForUser, getCollabWsUrl } from '@/lib/collab';

const lowlight = createLowlight(all);

const FALLBACK_VALUE: Value = [
  { type: 'p', children: [{ text: '' }] },
] as unknown as Value;

function normalizeValue(value: unknown): Value {
  if (Array.isArray(value) && value.length > 0) return value as Value;
  return FALLBACK_VALUE;
}

export interface CollabEditorProps {
  documentId: string;
  initialContent?: unknown[] | null;
  /** Pass to enable live collaboration. Omit for read-only / solo fallback. */
  userId?: string;
  userName?: string;
  userAvatar?: string;
  placeholder?: string;
}

export function CollabEditor({
  documentId,
  initialContent,
  userId,
  userName,
  userAvatar,
  placeholder = 'Type, or press / for commands…',
}: CollabEditorProps) {
  const enableCollab = !!userId;
  const displayName = userName?.trim() || 'Anonymous';

  // Memoise the YjsPlugin so it doesn't churn between renders. Identity
  // must change when the document or user changes so the CRDT is rebuilt.
  const yjsPlugin = useMemo(() => {
    if (!enableCollab) return null;
    return YjsPlugin.configure({
      render: { afterEditable: RemoteCursorOverlay },
      options: {
        cursors: {
          data: {
            userId,
            name: displayName,
            color: cursorColorForUser(userId),
          },
        },
        providers: [
          {
            type: 'hocuspocus',
            options: {
              name: documentId,
              url: getCollabWsUrl(),
              token: userId,
            },
          },
        ],
      },
    });
  }, [enableCollab, documentId, userId, displayName]);

  const editor = usePlateEditor(
    {
      // When Yjs owns the state, skip Slate's built-in init.
      ...(enableCollab ? { skipInitialization: true } : {}),
      plugins: [
        ...MarkdownKit,
        ParagraphPlugin.withComponent(ParagraphElement),
        BoldPlugin,
        ItalicPlugin,
        UnderlinePlugin,
        StrikethroughPlugin,
        SubscriptPlugin,
        SuperscriptPlugin,
        CodePlugin.withComponent(CodeLeaf),
        KbdPlugin.withComponent(KbdLeaf),
        HighlightPlugin.withComponent(HighlightLeaf),
        FontFamilyPlugin,
        FontSizePlugin,
        TextAlignPlugin.configure({
          inject: {
            nodeProps: {
              defaultNodeValue: 'start',
              nodeKey: 'align',
              styleKey: 'textAlign',
              validNodeValues: [
                'start',
                'left',
                'center',
                'right',
                'end',
                'justify',
              ],
            },
            targetPlugins: [
              KEYS.p,
              KEYS.h1,
              KEYS.h2,
              KEYS.h3,
              KEYS.h4,
              KEYS.h5,
              KEYS.h6,
              KEYS.blockquote,
            ],
          },
        }),
        H1Plugin.withComponent(H1Element),
        H2Plugin.withComponent(H2Element),
        H3Plugin.withComponent(H3Element),
        H4Plugin.withComponent(H4Element),
        H5Plugin.withComponent(H5Element),
        H6Plugin.withComponent(H6Element),
        BlockquotePlugin.withComponent(BlockquoteElement),
        HorizontalRulePlugin.withComponent(HrElement),
        LinkPlugin.configure({
          render: {
            node: LinkElement,
            afterEditable: () => <LinkFloatingToolbar />,
          },
        }),
        IndentPlugin.configure({
          inject: {
            targetPlugins: [
              KEYS.p,
              KEYS.h1,
              KEYS.h2,
              KEYS.h3,
              KEYS.blockquote,
            ],
          },
        }),
        ListPlugin.configure({
          inject: {
            targetPlugins: [
              KEYS.p,
              KEYS.h1,
              KEYS.h2,
              KEYS.h3,
              KEYS.blockquote,
            ],
          },
        }),
        CodeBlockPlugin.configure({
          node: { component: CodeBlockElement },
          options: { lowlight },
          shortcuts: { toggle: { keys: 'mod+alt+8' } },
        }),
        CodeLinePlugin.withComponent(CodeLineElement),
        CodeSyntaxPlugin.withComponent(CodeSyntaxLeaf),
        TrailingBlockPlugin,
        ...AutoformatKit,
        ...(yjsPlugin ? [yjsPlugin] : []),
      ],
      value: () => normalizeValue(initialContent),
    },
    [documentId, enableCollab],
  );

  // ── Yjs lifecycle ──────────────────────────────────────────────
  // Connect on mount, disconnect on unmount or when the doc changes.
  // We track init state per-document so React Strict Mode's double effect
  // doesn't trigger duplicate provider connects.
  const [collabReady, setCollabReady] = useState(!enableCollab);
  const initStateRef = useRef<{ docId: string | null; initialised: boolean }>({
    docId: null,
    initialised: false,
  });

  useEffect(() => {
    if (!enableCollab) return;

    const state = initStateRef.current;
    if (state.docId !== documentId) {
      state.docId = documentId;
      state.initialised = false;
    }
    if (state.initialised) return;
    state.initialised = true;

    let cancelled = false;
    const init = async () => {
      try {
        await editor.getApi(YjsPlugin).yjs.init({
          id: documentId,
          value: normalizeValue(initialContent),
          autoSelect: 'end',
          onReady: () => {
            if (!cancelled) setCollabReady(true);
          },
        });
        if (!cancelled) setCollabReady(true);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('already connected')) {
          console.error('[collab-editor] Yjs init failed', err);
        }
        if (!cancelled) setCollabReady(true);
      }
    };
    void init();

    return () => {
      cancelled = true;
      setCollabReady(false);
      state.initialised = false;
      try {
        const providers = editor.getOptions(YjsPlugin)._providers;
        providers?.forEach((p: Record<string, unknown>) => {
          const prov = p.provider as Record<string, unknown> | undefined;
          if (prov && typeof prov.disconnect === 'function') {
            (prov.disconnect as () => void)();
          }
        });
      } catch {
        /* ignore */
      }
    };
  }, [editor, enableCollab, documentId, initialContent]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Plate editor={editor}>
        <EditorToolbar />
        <div className="relative flex-1 min-h-0 overflow-hidden">
          <EditorContainer className="h-full overflow-y-auto">
            {enableCollab && !collabReady && (
              <div className="absolute inset-0 z-10 flex items-start justify-center bg-background/80 pt-24 backdrop-blur-sm">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  <span className="text-sm">Syncing document…</span>
                </div>
              </div>
            )}
            <Editor
              variant="default"
              placeholder={placeholder}
              className="px-12 pt-8 pb-32 sm:px-[max(64px,calc(50%-380px))]"
            />
          </EditorContainer>

          {/* Status pill */}
          <div className="pointer-events-none absolute bottom-4 left-4 z-20 flex items-center gap-2">
            {enableCollab ? (
              <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-background/80 px-3 py-1 text-xs shadow-sm backdrop-blur-sm">
                <span
                  className={
                    collabReady
                      ? 'inline-block h-1.5 w-1.5 rounded-full bg-green-500'
                      : 'inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500'
                  }
                />
                <span className="text-muted-foreground">
                  {collabReady ? 'Live' : 'Connecting…'}
                </span>
                <PresenceStack
                  localUser={{
                    name: displayName,
                    color: cursorColorForUser(userId),
                    avatar: userAvatar,
                  }}
                />
              </div>
            ) : (
              <div className="pointer-events-auto rounded-full border border-border bg-background/80 px-3 py-1 text-xs text-muted-foreground shadow-sm backdrop-blur-sm">
                Read-only
              </div>
            )}
          </div>
        </div>
      </Plate>
    </div>
  );
}
