/**
 * `/messages` and `/messages/:id` — Messenger-style direct messages.
 *
 * The whole thread is server-rendered before any script runs: without
 * JavaScript the page is still a working chat (the composer is a plain form
 * post, and reloading shows new messages). The client then upgrades it in
 * place with a WebSocket, so the markup below carries the hooks it needs —
 * `data-thread`, `data-conversation`, `data-latest-cursor` — and nothing else.
 *
 * On wide screens both panes are shown side by side; on a phone the list and
 * the thread are separate pages. That is pure CSS, so no duplicate markup and
 * no layout branch on the server.
 */

import { html, raw } from '../../utils/html';
import type { ConversationDTO, MessageDTO } from '../../types/models';
import { relativeTime, toIso } from '../../utils/time';
import { avatar } from '../components/avatar';
import { emptyState } from '../components/post';

export interface MessagesPageInput {
  conversations: ConversationDTO[];
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

/** Preserve the author's line breaks without allowing any markup through. */
function chatText(content: string): string {
  return html`${content}`.replace(/\n/g, '<br>');
}

function conversationRow(item: ConversationDTO, activeId: string | null): string {
  const last = item.lastMessage;
  return html`
    <li class="convo ${item.id === activeId ? 'is-active' : ''} ${item.unreadCount ? 'convo--unread' : ''}"
        data-conversation-row="${item.id}">
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

export function messageBubble(message: MessageDTO): string {
  return html`
    <li class="bubble ${message.mine ? 'bubble--mine' : ''}" data-message-id="${message.id}">
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
        <div class="bubble__text">${raw(chatText(message.content))}</div>
        <time class="bubble__time" datetime="${toIso(message.createdAt)}">${relativeTime(message.createdAt)}</time>
      </div>
    </li>
  `;
}

function conversationList(input: MessagesPageInput, activeId: string | null): string {
  return html`
    <aside class="messenger__list ${activeId ? 'is-secondary' : ''}" aria-label="Conversations">
      <div class="messenger__listhead">
        <h1 class="pagehead__title">Messages</h1>
        <button class="btn btn--small btn--ghost" type="button" data-new-conversation aria-expanded="false">
          New
        </button>
      </div>

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

      ${input.conversations.length
        ? raw(html`<ul class="convolist" data-conversation-list>
            ${input.conversations.map((item) => raw(conversationRow(item, activeId)))}
          </ul>`)
        : raw(
            emptyState(
              'No conversations yet',
              'Find someone you follow and say hello — messages are private, only you and they can read them.',
              { href: '/explore', label: 'Find people' },
            ),
          )}
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

        <form class="chatbox" method="post" action="/api/messages/${active.id}" data-message-form>
          <input type="hidden" name="_csrf" value="${input.csrfToken ?? ''}">
          <label class="sr-only" for="message-input">Message ${peerName}</label>
          <textarea id="message-input" class="chatbox__input" name="content" rows="1" required
                    maxlength="4000" placeholder="Write a message…" autocomplete="off"></textarea>
          <button class="btn btn--primary chatbox__send" type="submit">Send</button>
        </form>
        <p class="chatbox__hint muted">Enter sends · Shift + Enter adds a line</p>
      </section>
    </div>
  `;
}
