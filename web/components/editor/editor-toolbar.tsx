'use client';

/**
 * Editor formatting toolbar — block type, marks, alignment, lists, links,
 * undo/redo. Lives at the top of the editor surface, inside the Plate
 * provider so it can read the active editor.
 *
 * Uses native `title` attributes for tooltips because the project's shared
 * `ToolbarButton.tooltip` prop wraps with Radix Tooltip which isn't provided
 * by the app shell (the app uses Base UI tooltips elsewhere).
 */

import { triggerFloatingLink } from '@platejs/link/react';
import { ListStyleType, toggleList } from '@platejs/list';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ChevronDown,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Italic,
  Link2,
  List,
  ListOrdered,
  Minus,
  Quote,
  Redo2,
  Strikethrough,
  Subscript,
  Superscript,
  Type,
  Underline,
  Undo2,
} from 'lucide-react';
import {
  useEditorRef,
  useEditorSelector,
  useMarkToolbarButton,
  useMarkToolbarButtonState,
} from 'platejs/react';
import type { ComponentProps } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

const BLOCK_TYPES = [
  { type: 'p', label: 'Paragraph', icon: Type },
  { type: 'h1', label: 'Heading 1', icon: Heading1 },
  { type: 'h2', label: 'Heading 2', icon: Heading2 },
  { type: 'h3', label: 'Heading 3', icon: Heading3 },
  { type: 'blockquote', label: 'Quote', icon: Quote },
  { type: 'code_block', label: 'Code block', icon: Code },
] as const;

/** Plain button styled like a toolbar item. Falls back to native title tooltip. */
function TbButton({
  active,
  className,
  ...props
}: ComponentProps<'button'> & { active?: boolean }) {
  return (
    <button
      type="button"
      data-active={active ? 'true' : undefined}
      className={cn(
        'inline-flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-sm transition-colors',
        'hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        'data-[active=true]:bg-accent data-[active=true]:text-accent-foreground',
        '[&_svg]:size-4 [&_svg]:shrink-0',
        className,
      )}
      {...props}
    />
  );
}

function TbDivider() {
  return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />;
}

function MarkButton({
  nodeType,
  title,
  children,
}: {
  nodeType: string;
  title: string;
  children: React.ReactNode;
}) {
  const state = useMarkToolbarButtonState({ nodeType });
  const { props: handlers } = useMarkToolbarButton(state);
  // Strip `pressed` — it's intended for a Radix Toggle, not a native <button>.
  // We already surface it via the `active` prop below.
  const { pressed: _pressed, ...buttonHandlers } = handlers;
  return (
    <TbButton title={title} active={state.pressed} {...buttonHandlers}>
      {children}
    </TbButton>
  );
}

export function EditorToolbar() {
  // biome-ignore lint/suspicious/noExplicitAny: Plate `tf` is augmented at runtime by plugins.
  const editor = useEditorRef() as any;

  const activeBlockType = useEditorSelector((ed) => {
    const entry = ed.api.block();
    if (!entry) return 'p';
    const [node] = entry as [{ type?: string }, unknown];
    return node?.type ?? 'p';
  }, []);

  const activeBlock =
    BLOCK_TYPES.find((b) => b.type === activeBlockType) ?? BLOCK_TYPES[0];
  const ActiveIcon = activeBlock.icon;

  const setBlockType = (type: string) => {
    if (type === 'h1' || type === 'h2' || type === 'h3') {
      editor.tf.toggleBlock(type);
    } else if (type === 'blockquote') {
      editor.tf.toggleBlock('blockquote');
    } else if (type === 'code_block') {
      editor.tf.toggleBlock('code_block');
    } else {
      editor.tf.setNodes({ type });
    }
    editor.tf.focus();
  };

  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      className="flex w-full flex-wrap items-center gap-0.5 border-b bg-background/95 px-3 py-1.5 backdrop-blur-sm"
    >
      <TbButton title="Undo (⌘+Z)" onClick={() => editor.undo()}>
        <Undo2 />
      </TbButton>
      <TbButton title="Redo (⌘+⇧+Z)" onClick={() => editor.redo()}>
        <Redo2 />
      </TbButton>

      <TbDivider />

      {/* Block type dropdown */}
      <DropdownMenu>
        <DropdownMenuTrigger className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-sm font-medium hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <ActiveIcon className="h-3.5 w-3.5" />
          <span className="text-xs">{activeBlock.label}</span>
          <ChevronDown className="h-3 w-3 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {BLOCK_TYPES.map(({ type, label, icon: Icon }) => (
            <DropdownMenuItem key={type} onClick={() => setBlockType(type)}>
              <Icon className="mr-2 h-4 w-4" />
              <span>{label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <TbDivider />

      <MarkButton nodeType="bold" title="Bold (⌘+B)">
        <span className="font-bold">B</span>
      </MarkButton>
      <MarkButton nodeType="italic" title="Italic (⌘+I)">
        <Italic />
      </MarkButton>
      <MarkButton nodeType="underline" title="Underline (⌘+U)">
        <Underline />
      </MarkButton>
      <MarkButton nodeType="strikethrough" title="Strikethrough">
        <Strikethrough />
      </MarkButton>
      <MarkButton nodeType="code" title="Inline code (⌘+E)">
        <Code />
      </MarkButton>
      <MarkButton nodeType="highlight" title="Highlight">
        <Highlighter />
      </MarkButton>

      <TbDivider />

      <MarkButton nodeType="superscript" title="Superscript">
        <Superscript />
      </MarkButton>
      <MarkButton nodeType="subscript" title="Subscript">
        <Subscript />
      </MarkButton>

      <TbDivider />

      {/* Alignment */}
      <DropdownMenu>
        <DropdownMenuTrigger
          title="Align"
          className="inline-flex h-8 items-center gap-1 rounded-md px-1.5 hover:bg-muted transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <AlignLeft className="h-4 w-4" />
          <ChevronDown className="h-3 w-3 opacity-60" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuItem onClick={() => editor.tf.textAlign.setNodes('left')}>
            <AlignLeft className="mr-2 h-4 w-4" /> Left
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => editor.tf.textAlign.setNodes('center')}>
            <AlignCenter className="mr-2 h-4 w-4" /> Center
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => editor.tf.textAlign.setNodes('right')}>
            <AlignRight className="mr-2 h-4 w-4" /> Right
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => editor.tf.textAlign.setNodes('justify')}>
            <AlignJustify className="mr-2 h-4 w-4" /> Justify
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <TbDivider />

      <TbButton
        title="Bulleted list"
        onClick={() => toggleList(editor, { listStyleType: ListStyleType.Disc })}
      >
        <List />
      </TbButton>
      <TbButton
        title="Numbered list"
        onClick={() => toggleList(editor, { listStyleType: ListStyleType.Decimal })}
      >
        <ListOrdered />
      </TbButton>

      <TbDivider />

      <TbButton
        title="Insert link (⌘+K)"
        onClick={() => triggerFloatingLink(editor, { focused: true })}
      >
        <Link2 />
      </TbButton>
      <TbButton
        title="Horizontal rule"
        onClick={() => {
          editor.tf.insertNodes({ type: 'hr', children: [{ text: '' }] });
        }}
      >
        <Minus />
      </TbButton>
    </div>
  );
}
