'use client';

/**
 * Live presence avatars for the active document. Reads from the Yjs awareness
 * provided by `@platejs/yjs`.
 */

import { YjsPlugin } from '@platejs/yjs/react';
import { useEditorRef } from 'platejs/react';
import { useEffect, useState } from 'react';

import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from '@/components/ui/avatar';

interface PresenceUser {
  clientId: number;
  userId?: string;
  name: string;
  color: string;
  avatar?: string;
}

interface AwarenessState {
  user?: { userId?: string; name?: string; color?: string };
  data?: { userId?: string; name?: string; color?: string };
}

interface AwarenessLike {
  clientID?: number;
  getStates?: () => Map<number, AwarenessState>;
  on: (e: string, fn: () => void) => void;
  off: (e: string, fn: () => void) => void;
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s@.]+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

export function PresenceStack({
  localUser,
}: {
  localUser?: { name: string; color: string; avatar?: string };
}) {
  const [users, setUsers] = useState<PresenceUser[]>([]);
  const editor = useEditorRef();
  const awareness = editor.getOptions(YjsPlugin)?.awareness as
    | AwarenessLike
    | undefined;

  useEffect(() => {
    if (!awareness?.getStates) return;

    const sync = () => {
      const states = awareness.getStates!();
      const list: PresenceUser[] = [];
      states.forEach((state, clientId) => {
        const data = state.user ?? state.data;
        if (clientId === awareness.clientID && localUser) {
          list.push({
            clientId,
            userId: data?.userId,
            name: data?.name ?? localUser.name,
            color: data?.color ?? localUser.color,
            avatar: localUser.avatar,
          });
        } else if (data && (data.name || data.color)) {
          list.push({
            clientId,
            userId: data.userId,
            name: data.name ?? 'Anonymous',
            color: data.color ?? '#aaa',
          });
        }
      });

      // Dedupe by userId so multi-tab from same user shows once.
      const seen = new Set<string>();
      const deduped: PresenceUser[] = [];
      for (const u of list) {
        const key = u.userId ?? `client-${u.clientId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(u);
      }
      setUsers(deduped);
    };

    sync();
    const onChange = () => sync();
    awareness.on('change', onChange);
    return () => awareness.off('change', onChange);
  }, [awareness, localUser]);

  if (users.length === 0) return null;

  const visible = users.slice(0, 5);
  const overflow = users.length - visible.length;

  return (
    <AvatarGroup>
      {visible.map((u) => (
        <Avatar
          key={u.userId ?? u.clientId}
          title={u.name}
          size="sm"
          className="border-2 border-background shadow-sm"
          style={{ backgroundColor: u.color }}
        >
          <AvatarImage src={u.avatar ?? undefined} alt={u.name} />
          <AvatarFallback
            className="text-[10px] font-medium text-white"
            style={{ backgroundColor: u.color }}
          >
            {initials(u.name)}
          </AvatarFallback>
        </Avatar>
      ))}
      {overflow > 0 && (
        <AvatarGroupCount className="border-2 border-background text-[10px]">
          +{overflow}
        </AvatarGroupCount>
      )}
    </AvatarGroup>
  );
}
