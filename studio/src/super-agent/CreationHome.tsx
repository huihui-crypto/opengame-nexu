import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from 'open-design-ui/button';
import type { SuperAgentDesignModuleId } from '../../../shared/super-agent';
import { Popover } from '../components/ui/Popover';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import type { ModeComposerOptions } from './ModeComposerControls';
import type { SuperAgentCreationModeId } from './ModeResourceShowcase';
import './creationHome.css';

const EXTRA_STARTERS: {
  key: string;
  id: SuperAgentCreationModeId;
  designModule?: SuperAgentDesignModuleId;
  optionsPatch?: Partial<ModeComposerOptions>;
  tone: 'coding' | 'agent' | 'image' | 'video' | 'audio';
  icon: string;
  title: string;
}[] = [
  { key: 'research', id: 'research', tone: 'agent', icon: 'book-open-line', title: 'Research a topic' },
  { key: 'visualization', id: 'visualization', tone: 'coding', icon: 'bar-chart-box-line', title: 'Visualization' },
  { key: 'document', id: 'design', designModule: 'document', tone: 'image', icon: 'file-text-line', title: 'Document' },
  { key: 'image', id: 'design', designModule: 'image', tone: 'image', icon: 'image-line', title: 'Generate image' },
  { key: 'website', id: 'design', designModule: 'prototype', tone: 'image', icon: 'layout-line', title: 'Build a website' },
  { key: 'audio', id: 'audio', tone: 'audio', icon: 'music-2-line', title: 'Create audio' },
  { key: 'coding', id: 'coding', tone: 'coding', icon: 'code-s-slash-line', title: 'Coding' },
];

function TileContent({ icon, title, description }: { icon: string; title: string; description: string }) {
  return <CardSurface>
    <span className="om-sa-tile-top" aria-hidden="true">
      <RemixIcon name={icon} size={20} className="om-sa-tile-icon" />
      <RemixIcon name="arrow-right-up-line" size={14} />
    </span>
    <span className="om-sa-tile-copy"><strong>{title}</strong><small>{description}</small></span>
  </CardSurface>;
}

function CardSurface({ children }: { children: ReactNode }) {
  return (
    <span className="om-sa-starter-surface">
      <span className="om-sa-card-glare" aria-hidden="true" />
      {children}
    </span>
  );
}

function bindCardMotion(card: HTMLButtonElement, motion: MediaQueryList) {
  const horizontal = { target: 0, position: 0, velocity: 0 };
  const vertical = { target: 0, position: 0, velocity: 0 };
  const axes = [horizontal, vertical];
  let hovered = false;
  let reflection = 0;
  let frame = 0;
  let lastTime = 0;

  const update = (now: number) => {
    frame = 0;
    const elapsed = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    // A damped spring lets the face settle after the pointer has stopped.
    const steps = Math.max(1, Math.ceil(elapsed * 120));
    const step = elapsed / steps;
    for (const axis of axes) {
      for (let index = 0; index < steps; index++) {
        axis.velocity += (120 * (axis.target - axis.position) - 16 * axis.velocity) * step;
        axis.position += axis.velocity * step;
      }
      if (Math.abs(axis.target - axis.position) < 0.001 && Math.abs(axis.velocity) < 0.001) {
        axis.position = axis.target;
        axis.velocity = 0;
      }
    }
    const opacity = Number(hovered);
    reflection += (opacity - reflection) * -Math.expm1(-elapsed / (hovered ? 0.18 : 0.45));
    if (Math.abs(opacity - reflection) < 0.004) reflection = opacity;

    card.style.setProperty('--sa-card-x', horizontal.position.toFixed(4));
    card.style.setProperty('--sa-card-y', vertical.position.toFixed(4));
    card.style.setProperty('--sa-card-reflection', reflection.toFixed(4));
    if (axes.some(axis => axis.position !== axis.target || axis.velocity) || reflection !== opacity) {
      frame = requestAnimationFrame(update);
    }
  };
  const schedule = () => {
    if (frame) return;
    lastTime = performance.now();
    frame = requestAnimationFrame(update);
  };
  const follow = (event: PointerEvent) => {
    if (!motion.matches || event.pointerType === 'touch') return;
    const { left, top, width, height } = card.getBoundingClientRect();
    if (!width || !height) return;
    horizontal.target = Math.max(-1, Math.min(1, 2 * (event.clientX - left) / width - 1));
    vertical.target = Math.max(-1, Math.min(1, 2 * (event.clientY - top) / height - 1));
    hovered = true;
    schedule();
  };
  const release = () => {
    if (!hovered) return;
    hovered = false;
    horizontal.target = 0;
    vertical.target = 0;
    schedule();
  };
  const reset = () => {
    cancelAnimationFrame(frame);
    frame = 0;
    hovered = false;
    reflection = 0;
    for (const axis of axes) {
      axis.position = 0;
      axis.target = 0;
      axis.velocity = 0;
    }
    card.style.removeProperty('--sa-card-x');
    card.style.removeProperty('--sa-card-y');
    card.style.removeProperty('--sa-card-reflection');
  };

  card.addEventListener('pointerenter', follow);
  card.addEventListener('pointermove', follow);
  card.addEventListener('pointerleave', release);
  card.addEventListener('pointercancel', release);
  window.addEventListener('blur', reset);
  motion.addEventListener('change', reset);
  return () => {
    reset();
    card.removeEventListener('pointerenter', follow);
    card.removeEventListener('pointermove', follow);
    card.removeEventListener('pointerleave', release);
    card.removeEventListener('pointercancel', release);
    window.removeEventListener('blur', reset);
    motion.removeEventListener('change', reset);
  };
}

export function CreationHome({ active, onEnterMode }: {
  active: boolean;
  onEnterMode: (mode: SuperAgentCreationModeId, designModule?: SuperAgentDesignModuleId, patch?: Partial<ModeComposerOptions>) => void;
}) {
  const { t } = useI18n();
  const [gameTitleStart, gameTitleAccent, gameTitleEnd] = t('Anyone can build {highlightStart}games that earn{highlightEnd}.')
    .split(/\{highlightStart\}|\{highlightEnd\}/);
  const starterGridRef = useRef<HTMLDivElement>(null);
  const [moreStartersOpen, setMoreStartersOpen] = useState(false);
  useEffect(() => { if (!active) setMoreStartersOpen(false); }, [active]);
  useEffect(() => {
    if (!active || !starterGridRef.current) return;
    const motion = window.matchMedia('(any-hover: hover) and (prefers-reduced-motion: no-preference)');
    const cards = starterGridRef.current.querySelectorAll<HTMLButtonElement>('.om-sa-starter-card');
    const cleanup = Array.from(cards, card => bindCardMotion(card, motion));
    return () => cleanup.forEach(stop => stop());
  }, [active]);
  return (
    <div className="om-sa-home">
      <div className="om-sa-home-hero">
        <h2>{t('What would you like to create today?')}</h2>
        <p>{t('Start with an idea and bring it to life.')}</p>
      </div>
      <div className="om-sa-starter-grid" ref={starterGridRef}>
        <Button type="button" variant="plain" className="om-sa-starter-card om-sa-game-feature" aria-label={t('Build a game')} onClick={() => onEnterMode('game')}>
          <CardSurface>
            <span className="om-sa-game-label"><RemixIcon name="gamepad-line" size={20} />{t('Build a game')} <span className="om-badge" data-nav-badge="New" lang="en">New</span></span>
            <span className="om-sa-game-copy">
              <strong>{gameTitleStart}<span className="om-sa-game-title-accent">{gameTitleAccent}</span>{gameTitleEnd}</strong>
              <small>{t('Turn your idea into a playable game')}</small>
              <span className="om-sa-game-cta">{t('Build a game')} <RemixIcon name="arrow-right-up-line" size={16} /></span>
            </span>
          </CardSurface>
        </Button>
        <Button type="button" variant="plain" className="om-sa-starter-card" data-tone="image" onClick={() => onEnterMode('design')}>
          <TileContent icon="palette-line" title={t('Design Studio')} description={t('Design interfaces and assets')} />
        </Button>
        <Button type="button" variant="plain" className="om-sa-starter-card" data-tone="video" onClick={() => onEnterMode('motion', undefined, { motionEngine: 'video-model' })}>
          <TileContent icon="clapperboard-line" title={t('Make a video')} description={t('Turn ideas into films')} />
        </Button>
        <Button type="button" variant="plain" className="om-sa-starter-card" data-tone="slides" onClick={() => onEnterMode('design', 'deck')}>
          <TileContent icon="slideshow-line" title={t('Create slides')} description={t('Present your ideas clearly')} />
        </Button>
        <Popover
          open={moreStartersOpen}
          onOpenChange={setMoreStartersOpen}
          side="bottom"
          align="end"
          initialFocus={false}
          aria-label={t('Explore more')}
          className="om-agent-settings-popover om-sa-more-popover"
          trigger={
            <Button
              variant="plain"
              type="button"
              className="om-sa-starter-card om-sa-starter-card-more"
              data-active={moreStartersOpen || undefined}
            >
              <TileContent icon="apps-2-line" title={t('Explore more')} description={t('Discover more creative tools')} />
            </Button>
          }
        >
          <div className="om-sa-more-menu">
            {EXTRA_STARTERS.map(card => (
              <Button
                key={card.key}
                variant="plain"
                type="button"
                className="om-sa-more-item"
                onClick={() => {
                  setMoreStartersOpen(false);
                  onEnterMode(card.id, card.designModule, card.optionsPatch);
                }}
              >
                <span className="om-sa-starter-icon" data-tone={card.tone} aria-hidden="true">
                  <RemixIcon name={card.icon} size={16} />
                </span>
                <span>{t(card.title)}</span>
              </Button>
            ))}
          </div>
        </Popover>
      </div>
    </div>
  );
}
