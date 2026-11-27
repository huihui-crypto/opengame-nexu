// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { SuperAgentMessage } from '../../../../shared/super-agent';
import { I18nProvider } from '../../i18n/I18n';
import { GamePublishThread } from './GamePublishThread';
import { gamePublishActions, gamePublishSessionFor, resetGamePublishStore } from './gamePublishStore';

vi.mock('../../motion/superAgentHandoff', () => ({ queueSuperAgentHandoff: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('keeps Douyin steps actionable and removes instructions already delivered by the current Agent reply', async () => {
  const artifactId = 'game:abc';
  const chatId = 'chat-1';
  const heading = 'Step 1 of 3 · Get a Mini Game AppID';
  const consoleUrl = 'https://developer.open-douyin.com/console';
  const guide = `**${heading}**\n\nRegister a game in the [developer console](${consoleUrl}) and copy its AppID.`;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onOpenPanel = vi.fn();
  const render = (messages: SuperAgentMessage[]) => act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <GamePublishThread chatId={chatId} messages={messages} onOpenPanel={onOpenPanel} />
      </I18nProvider>,
    );
  });
  const consoleLink = () => host.querySelector(`a[href="${consoleUrl}"]`);
  const done = () => [...host.querySelectorAll('button')].find(button => button.textContent === 'Done');

  try {
    gamePublishActions.open({ artifactId, chatId, gameId: 'abc', gameTitle: 'Slingshot' });
    gamePublishActions.setLinkToo(artifactId, false);
    gamePublishActions.choose(artifactId, 'douyin-minigame');
    const requestedAt = gamePublishSessionFor(artifactId)!.guideRequestedAt!;
    expect(requestedAt).toBeTypeOf('number');
    const oldGuide: SuperAgentMessage = { id: 'old', role: 'assistant', status: 'completed', text: guide, createdAt: requestedAt - 1 };
    const current: SuperAgentMessage = { id: 'current', role: 'assistant', status: 'streaming', text: guide, createdAt: requestedAt + 1 };
    const unrelated: SuperAgentMessage = { ...current, id: 'unrelated', status: 'completed', text: 'The OpenDesign play link is ready.' };

    await render([oldGuide, unrelated, current]);
    expect(host.textContent).toContain(heading);
    expect(host.textContent).toContain('Copy the AppID');
    expect(consoleLink()).not.toBeNull();
    expect(done()?.disabled).toBe(false);

    await render([oldGuide, { ...current, status: 'completed', text: `**${heading}**` }]);
    expect(host.textContent).toContain('Copy the AppID');

    await render([{ ...current, status: 'completed', text: `**${heading}**\n\nRegister the mini game and copy its AppID.` }]);
    expect(host.textContent).not.toContain(heading);
    expect(host.textContent).not.toContain('Copy the AppID');
    expect(consoleLink()).not.toBeNull();

    await render([{ ...current, status: 'completed' }]);
    expect(host.textContent).not.toContain(heading);
    expect(consoleLink()).toBeNull();
    expect(done()?.disabled).toBe(false);
    await act(async () => { done()!.click(); });
    expect(gamePublishSessionFor(artifactId)?.stepIndex).toBe(1);
  } finally {
    await act(async () => { root.unmount(); });
    resetGamePublishStore();
    host.remove();
  }
});
