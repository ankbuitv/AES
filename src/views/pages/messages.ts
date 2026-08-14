/**
 * `/messages` and `/messages/:id` — Messenger-style direct messages.
 *
 * The whole thread is server-rendered before any script runs: without
 * JavaScript the page is still a working chat (the composer is a plain form
 * post, search is a GET form, and reloading shows new messages). The client
 * then upgrades it in place with a WebSocket, live search, an emoji picker,
 * photo attachments and voice notes, so the markup below carries the hooks it
 * needs — `data-thread`, `data-conversation`, `data-latest-cursor` — and
 * nothing else.
 *
 * On wide screens both panes are shown side by side; on a phone the list and
 * the thread are separate pages. That is pure CSS, so no duplicate markup and
 * no layout branch on the server.
 */

import { html, raw } from '../../utils/html';
import type { ConversationDTO, MessageDTO, MessagePeer } from '../../types/models';
import { relativeTime, toIso } from '../../utils/time';
import { avatar } from '../components/avatar';
import { emptyState } from '../components/post';

export interface MessagesPageInput {
  conversations: ConversationDTO[];
  /** People matching the search who the viewer has not messaged yet. */
  people?: MessagePeer[];
  /** Current inbox filter, echoed back into the search box. */
  query?: string;
  csrfToken: string | null;
  /** Present on `/messages/:id`. */
  active?: {
    id: string;
    peer: { id: string; username: string; displayName: string; avatarMediaId: string | null } | null;
    messages: MessageDTO[];
    nextCursor: string | null;
    hasMore: boolean;
    latestCursor: string | null;
  };
}

/**
 * Emoji offered by the picker, grouped the way people actually reach for them.
 * Kept server-side so the picker costs no extra request and stays identical
 * across every session.
 */
export const EMOJI_GROUPS: { label: string; emoji: string[] }[] = [
  {
    label: 'Smileys',
    emoji: ['😀', '😄', '😁', '😆', '😅', '🤣', '😂', '🙂', '😉', '😊', '😍', '🥰', '😘', '😜', '🤪', '🤔', '🤨', '😐', '😴', '😪'],
  },
  {
    label: 'Gestures',
    emoji: ['👍', '👎', '👌', '✌️', '🤞', '🤟', '🤙', '👏', '🙌', '🙏', '💪', '🫶', '👋', '🤝', '✊', '🫡'],
  },
  {
    label: 'Hearts',
    emoji: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💖', '💗', '💔', '❣️', '💕', '💞', '💘', '💝'],
  },
  {
    label: 'Life',
    emoji: ['🔥', '✨', '🎉', '🎊', '🎁', '🍀', '🌸', '🌈', '☀️', '🌙', '⭐', '⚡', '☕', '🍜', '🍕', '🍰', '🚀', '🏆', '💡', '📌'],
  },
  {
    label: 'Faces',
    emoji: ['😭', '😢', '😡', '🤯', '😱', '🥳', '🤗', '🤫', '🙄', '😬', '😷', '🤒', '👀', '💀', '👻', '🤖'],
  },
];

/**
 * Large stickers: an emoji sent on its own renders big, with no bubble chrome.
 * They are plain text, so they need no storage, no moderation pipeline and they
 * degrade to a readable character everywhere.
 */
export const STICKERS: string[] = ['👍', '❤️', '🔥', '😂', '😍', '🎉', '👏', '🙏', '💯', '🥳', '😭', '🤯'];

/** Preserve the author's line breaks without allowing any markup through. */
function chatText(content: string): string {
  return html`${content}`.replace(/\n/g, '<br>');
}

/** "0:07" from a millisecond duration. */
function clockDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function conversationRow(item: ConversationDTO, activeId: string | null): string {
  const last = item.lastMessage;
  return html`
    <li class="convo ${item.id === activeId ? 'is-active' : ''} ${item.unreadCount ? 'convo--unread' : ''}"
        data-conversation-row="${item.id}"
        data-search-name="${`${item.peer.displayName} @${item.peer.username}`.toLowerCase()}">
      <a class="convo__link" href="/messages/${item.id}">
        ${avatar(
          {
            id: item.peer.id,
            username: item.peer.username,
            displayName: item.peer.displayName,
            avatarMediaId: item.peer.avatarMediaId,
          },
          'md',
          false,
        )}
        <span class="convo__body">
          <span class="convo__top">
            <span class="convo__name">${item.peer.displayName}</span>
            ${last
              ? raw(
                  html`<time class="convo__time muted" datetime="${toIso(last.createdAt)}"
                    >${relativeTime(last.createdAt)}</time
                  >`,
                )
              : ''}
          </span>
          <span class="convo__preview muted">
            ${last ? `${last.mine ? 'You: ' : ''}${last.content}` : `@${item.peer.username}`}
          </span>
        </span>
        ${item.unreadCount
          ? raw(html`<span class="convo__badge" aria-label="${item.unreadCount} unread">${item.unreadCount}</span>`)
          : ''}
      </a>
    </li>
  `;
}

/**
 * A person the viewer has not messaged yet. Submitting the row opens the
 * conversation — one flow from "search" to "chatting", rather than making the
 * user retype the username into a separate form.
 */
function newPersonRow(person: MessagePeer, csrfToken: string | null): string {
  return html`
    <li class="convo convo--new">
      <form class="convo__link" method="post" action="/api/messages" data-open-conversation>
        <input type="hidden" name="_csrf" value="${csrfToken ?? ''}">
        <input type="hidden" name="username" value="${person.username}">
        ${avatar(
          {
            id: person.id,
            username: person.username,
            displayName: person.displayName,
            avatarMediaId: person.avatarMediaId,
          },
          'md',
          false,
        )}
        <span class="convo__body">
          <span class="convo__top"><span class="convo__name">${person.displayName}</span></span>
          <span class="convo__preview muted">@${person.username}</span>
        </span>
        <button class="btn btn--small btn--ghost" type="submit">Message</button>
      </form>
    </li>
  `;
}

export function messageBubble(message: MessageDTO): string {
  const isSticker = message.kind === 'sticker';
  return html`
    <li class="bubble ${message.mine ? 'bubble--mine' : ''} ${isSticker ? 'bubble--sticker' : ''}"
        data-message-id="${message.id}">
      ${message.mine
        ? ''
        : avatar(
            {
              id: message.sender.id,
              username: message.sender.username,
              displayName: message.sender.displayName,
              avatarMediaId: message.sender.avatarMediaId,
            },
            'sm',
          )}
      <div class="bubble__body">
        ${raw(bubbleContent(message))}
        <time class="bubble__time" datetime="${toIso(message.createdAt)}">${relativeTime(message.createdAt)}</time>
      </div>
    </li>
  `;
}

/** The inside of a bubble, which depends on what was sent. */
function bubbleContent(message: MessageDTO): string {
  if (message.kind === 'sticker') {
    return html`<div class="bubble__sticker" role="img" aria-label="Sticker">${message.content}</div>`;
  }

  if (message.kind === 'image' && message.mediaUrl) {
    return html`
      <a class="bubble__photo" href="${message.mediaUrl}" data-lightbox>
        <img src="${message.mediaUrl}" alt="${message.content}" loading="lazy" decoding="async">
      </a>
      ${message.content && message.content !== 'Photo'
        ? raw(html`<div class="bubble__text">${raw(chatText(message.content))}</div>`)
        : ''}
    `;
  }

  if (message.kind === 'audio' && message.mediaUrl) {
    return html`
      <div class="bubble__voice">
        <audio class="bubble__audio" src="${message.mediaUrl}" controls preload="none"></audio>
        ${message.durationMs
          ? raw(html`<span class="bubble__duration muted">${clockDuration(message.durationMs)}</span>`)
          : ''}
      </div>
      ${message.content && message.content !== 'Voice message'
        ? raw(html`<div class="bubble__text">${raw(chatText(message.content))}</div>`)
        : ''}
    `;
  }

  return html`<div class="bubble__text">${raw(chatText(message.content))}</div>`;
}

function conversationList(input: MessagesPageInput, activeId: string | null): string {
  const people = input.people ?? [];
  const query = input.query ?? '';

  return html`
    <aside class="messenger__list ${activeId ? 'is-secondary' : ''}" aria-label="Conversations">
      <div class="messenger__listhead">
        <h1 class="pagehead__title">Messages</h1>
        <button class="btn btn--small btn--ghost" type="button" data-new-conversation aria-expanded="false">
          New
        </button>
      </div>

      <form class="messenger__search" method="get" action="/messages" role="search" data-inbox-search>
        <label class="sr-only" for="inbox-q">Search conversations</label>
        <input id="inbox-q" class="messenger__searchinput" name="q" type="search" value="${query}"
               placeholder="Search by name or @handle" autocomplete="off" maxlength="60"
               data-inbox-query enterkeyhint="search">
        <button class="btn btn--small btn--ghost messenger__searchgo" type="submit">Search</button>
      </form>

      <form class="messenger__new" method="post" action="/api/messages" data-new-conversation-form hidden>
        <input type="hidden" name="_csrf" value="${input.csrfToken ?? ''}">
        <label class="field">
          <span class="field__label">Username</span>
          <input class="field__input" name="username" type="text" required maxlength="24"
                 autocomplete="off" placeholder="who do you want to talk to?">
        </label>
        <label class="field">
          <span class="field__label">First message</span>
          <textarea class="field__input" name="content" rows="2" maxlength="4000"
                    placeholder="Say hello…"></textarea>
        </label>
        <button class="btn btn--primary btn--small" type="submit">Start conversation</button>
      </form>

      <div data-inbox-results>
        ${input.conversations.length
          ? raw(html`<ul class="convolist" data-conversation-list>
              ${input.conversations.map((item) => raw(conversationRow(item, activeId)))}
            </ul>`)
          : raw(
              query
                ? html`<p class="messenger__noresults muted">No conversation matches “${query}”.</p>`
                : emptyState(
                    'No conversations yet',
                    'Find someone you follow and say hello — messages are private, only you and they can read them.',
                    { href: '/explore', label: 'Find people' },
                  ),
            )}

        ${people.length
          ? raw(html`
              <p class="messenger__grouplabel muted">People you haven't messaged</p>
              <ul class="convolist" data-people-list>
                ${people.map((person) => raw(newPersonRow(person, input.csrfToken)))}
              </ul>`)
          : ''}
      </div>
    </aside>
  `;
}

/** The list-only view at `/messages`. */
export function renderMessagesPage(input: MessagesPageInput): string {
  return html`
    <div class="messenger">
      ${raw(conversationList(input, null))}
      <section class="messenger__thread messenger__thread--empty">
        ${raw(
          emptyState(
            'Pick a conversation',
            'Your messages appear here. Choose someone on the left, or start a new conversation.',
          ),
        )}
      </section>
    </div>
  `;
}

/** Emoji picker + sticker tray. Hidden until the client opens it. */
function emojiPanel(): string {
  return html`
    <div class="emojipanel" data-emoji-panel hidden>
      <div class="emojipanel__tray">
        <p class="emojipanel__label muted">Send as a sticker</p>
        <div class="emojipanel__stickers">
          ${STICKERS.map(
            (glyph) =>
              raw(html`<button class="emojipanel__sticker" type="button" data-sticker="${glyph}"
                        aria-label="Send ${glyph} sticker">${glyph}</button>`),
          )}
        </div>
      </div>
      ${EMOJI_GROUPS.map(
        (group) =>
          raw(html`
            <div class="emojipanel__group">
              <p class="emojipanel__label muted">${group.label}</p>
              <div class="emojipanel__grid">
                ${group.emoji.map(
                  (glyph) =>
                    raw(html`<button class="emojipanel__emoji" type="button" data-emoji="${glyph}"
                              aria-label="Insert ${glyph}">${glyph}</button>`),
                )}
              </div>
            </div>`),
      )}
    </div>
  `;
}

/** The thread view at `/messages/:id`. */
export function renderConversationPage(input: MessagesPageInput): string {
  const active = input.active;
  if (!active) return renderMessagesPage(input);
  const peerName = active.peer?.displayName ?? 'Conversation';

  return html`
    <div class="messenger messenger--thread">
      ${raw(conversationList(input, active.id))}

      <section class="messenger__thread" data-thread data-conversation="${active.id}"
               data-latest-cursor="${active.latestCursor ?? ''}">
        <header class="thread__head">
          <a class="thread__back btn btn--small btn--ghost" href="/messages" aria-label="Back to conversations">←</a>
          ${active.peer
            ? avatar(
                {
                  id: active.peer.id,
                  username: active.peer.username,
                  displayName: active.peer.displayName,
                  avatarMediaId: active.peer.avatarMediaId,
                },
                'sm',
              )
            : ''}
          <div class="thread__who">
            <span class="thread__name">${peerName}</span>
            ${active.peer
              ? raw(html`<a class="thread__handle muted" href="/u/${active.peer.username}">@${active.peer.username}</a>`)
              : ''}
          </div>
          <span class="thread__status muted" data-thread-status aria-live="polite"></span>
        </header>

        <div class="thread__scroll" data-thread-scroll>
          ${active.hasMore && active.nextCursor
            ? raw(html`<div class="loadmore loadmore--older">
                <button class="btn btn--ghost btn--small" type="button" data-thread-older
                        data-cursor="${active.nextCursor}">Load older messages</button>
              </div>`)
            : ''}
          <ol class="bubbles" data-thread-messages>
            ${active.messages.map((message) => raw(messageBubble(message)))}
          </ol>
          <p class="thread__typing muted" data-thread-typing hidden></p>
        </div>

        <div class="chatdock">
          ${raw(emojiPanel())}

          <!-- Live preview of a voice clip before it is sent. -->
          <div class="voicebar" data-voice-bar hidden>
            <span class="voicebar__dot" aria-hidden="true"></span>
            <span class="voicebar__time" data-voice-time>0:00</span>
            <span class="voicebar__hint muted" data-voice-hint>Recording…</span>
            <button class="btn btn--small btn--ghost" type="button" data-voice-cancel>Cancel</button>
            <button class="btn btn--small btn--primary" type="button" data-voice-send>Send</button>
          </div>

          <form class="chatbox" method="post" action="/api/messages/${active.id}" data-message-form>
            <input type="hidden" name="_csrf" value="${input.csrfToken ?? ''}">

            <div class="chatbox__tools">
              <button class="chatbox__tool" type="button" data-emoji-toggle aria-expanded="false"
                      aria-label="Emoji and stickers" title="Emoji and stickers">😊</button>

              <label class="chatbox__tool" title="Send a photo">
                <span aria-hidden="true">🖼️</span>
                <span class="sr-only">Send a photo</span>
                <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-photo-input hidden>
              </label>

              <button class="chatbox__tool" type="button" data-voice-toggle
                      aria-label="Record a voice message" title="Record a voice message">🎙️</button>
            </div>

            <label class="sr-only" for="message-input">Message ${peerName}</label>
            <textarea id="message-input" class="chatbox__input" name="content" rows="4" required
                      maxlength="4000" placeholder="Write a message…" autocomplete="off"></textarea>
            <button class="btn btn--primary chatbox__send" type="submit">Send</button>
          </form>
          <p class="chatbox__hint muted">Enter sends · Shift + Enter adds a line · emoji, photos and voice notes supported</p>
        </div>
      </section>
    </div>
  `;
}
