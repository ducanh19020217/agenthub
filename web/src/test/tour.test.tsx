import { describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocaleProvider } from '../context/LocaleContext';
import { TourProvider, modalTourDefinitions, pageTours, tourDefinitions, useTour } from '../components/tour/TourContext';
import { TourOverlay, computePopoverPosition, VIEWPORT_MARGIN, POPOVER_GAP } from '../components/tour/TourOverlay';
import { translations, translate } from '../locales';
import { HelpPanel } from '../components/tour/HelpPanel';
import { InfoTooltip } from '../components/tour/InfoTooltip';
import { CreateTaskPage } from '../pages/CreateTaskPage';
import { AddProfileModal } from '../pages/ProfilesPage';
import { NewSessionModal } from '../components/chat/NewSessionModal';
import * as client from '../api/client';

function wrapper(children: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(client, 'getConfig').mockResolvedValue({ ui: { tours: {} } } as any);
  vi.spyOn(client, 'getSetupStatus').mockResolvedValue({ setupCompletedAt: 'now' } as any);
  return render(
    <LocaleProvider initialLocale="en">
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <TourProvider>
            {children}
          </TourProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </LocaleProvider>,
  );
}

describe('tour help and tooltips', () => {
  it('filters help tours and starts the selected tour', async () => {
    const close = vi.fn();
    wrapper(<HelpPanel open onClose={close} />);
    const search = screen.getByRole('textbox', { name: 'Search guides…' });
    fireEvent.change(search, { target: { value: 'performance' } });
    expect(screen.getByText('Overview')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Overview/i }));
    expect(close).toHaveBeenCalled();
  });

  it('closes the help panel and keeps every tour key translated in both locales', () => {
    const close = vi.fn();
    wrapper(<HelpPanel open onClose={close} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Close guide' })[1]);
    expect(close).toHaveBeenCalledTimes(1);

    const definitions = [...tourDefinitions, ...Object.values(pageTours), ...modalTourDefinitions];
    for (const step of definitions.flatMap((tour) => tour.steps)) {
      expect(translate('vi', step.title)).not.toBe(step.title);
      expect(translate('en', step.title)).not.toBe(step.title);
      expect(translate('vi', step.content)).not.toBe(step.content);
      expect(translate('en', step.content)).not.toBe(step.content);
    }
    expect(translations.vi.tour.steps).toBeDefined();
    expect(translations.en.tour.steps).toBeDefined();
  });

  it('does not advertise or navigate to the removed chat page', () => {
    expect(pageTours['/chat']).toBeUndefined();
    const definitions = [...tourDefinitions, ...Object.values(pageTours), ...modalTourDefinitions];
    expect(definitions.flatMap((tour) => tour.steps).some((step) => step.route === '/chat')).toBe(false);
  });

  it('suggests a modal tour only once', async () => {
    localStorage.clear();
    let suggest: ((id: string) => void) | undefined;
    let closeTour: (() => void) | undefined;
    const Probe = () => {
      const tour = useTour();
      suggest = tour.suggestModalTour;
      closeTour = tour.closeTour;
      return <span data-testid="active-tour">{tour.active?.id || ''}</span>;
    };
    wrapper(<Probe />);
    await waitFor(() => expect(suggest).toBeDefined());
    act(() => suggest?.('modal-create-task'));
    await waitFor(() => expect(screen.getByTestId('active-tour')).toHaveTextContent('modal-create-task'));
    act(() => closeTour?.());
    expect(localStorage.getItem('agenthub_tours_seen:modal-create-task')).toBe('1');
    act(() => suggest?.('modal-create-task'));
    expect(screen.getByTestId('active-tour')).not.toHaveTextContent('modal-create-task');
  });

  it('shows an info tooltip from keyboard activation with an accessible label', () => {
    render(<InfoTooltip text="Helpful context" label="Explain setting" />);
    const button = screen.getByRole('button', { name: 'Explain setting' });
    button.focus();
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.click(button);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Helpful context');
  });

  it('keeps modal tour selectors attached to the matching controls', async () => {
    wrapper(<CreateTaskPage />);
    await waitFor(() => expect(document.querySelector('[data-tour="modal-create-task"]')).toBeInTheDocument());
    expect(document.querySelector('[data-tour="task-difficulty"]')?.textContent).toContain('Complexity');
    expect(document.querySelector('[data-tour="task-dependencies"]')).toBeNull();

    const { unmount } = wrapper(
      <AddProfileModal onClose={vi.fn()} onCreated={vi.fn()} onImported={vi.fn()} />,
    );
    expect(document.querySelector('[data-tour="account-provider"]')).toBeInTheDocument();
    expect(document.querySelector('[data-tour="account-name"]')?.textContent).toContain('Account name');
    fireEvent.click(screen.getByRole('button', { name: 'Import Refresh Token' }));
    expect(document.querySelector('[data-tour="account-token"]')).toBeInTheDocument();
    unmount();

    wrapper(
      <NewSessionModal isOpen onClose={vi.fn()} onSubmit={vi.fn()} />,
    );
    expect(document.querySelector('[data-tour="session-mode"]')?.textContent).toContain('Operation mode');
    expect(document.querySelector('[data-tour="session-mode"]')?.textContent).not.toContain('Project (optional)');
  });

  it('keeps an account modal readable while its modal tour is active', async () => {
    localStorage.clear();
    const OpenModalTour = () => {
      const { openTour } = useTour();
      useEffect(() => openTour('modal-add-account'), [openTour]);
      return <><AddProfileModal onClose={vi.fn()} onCreated={vi.fn()} onImported={vi.fn()} /><TourOverlay /></>;
    };
    wrapper(<OpenModalTour />);

    await waitFor(() => expect(document.querySelector('[data-tour="account-provider"]')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId('tour-overlay')).toBeInTheDocument());
    const modal = screen.getByText('Add Account').closest('[role="dialog"]');
    const tour = screen.getByRole('dialog', { name: 'Provider and account type' });

    expect(modal).toHaveStyle({ zIndex: '110' });
    expect(tour).toHaveStyle({ zIndex: '115' });
    expect(tour.querySelector('[class~="bg-black/55"]')).toBeNull();
    expect(document.querySelector('[data-tour="account-provider"]')).toBeVisible();

    // Verify tour controls can advance and highlight the next element in the modal
    const nextBtn = screen.getByRole('button', { name: 'Next' });
    fireEvent.click(nextBtn);

    await waitFor(() => expect(screen.getByRole('dialog', { name: 'Login method' })).toBeInTheDocument());
    expect(document.querySelector('[data-tour="account-login-method"]')).toBeVisible();
    expect(tour).toHaveStyle({ zIndex: '115' });
  });

  it('keeps modal above page tour when target is on the page', async () => {
    localStorage.clear();
    const PageTourWithModal = () => {
      const { openTour } = useTour();
      useEffect(() => {
        openTour('page-profiles');
      }, [openTour]);
      return (
        <div>
          <div data-tour="profiles">Profiles</div>
          <button data-tour="add-account">Add</button>
          <AddProfileModal onClose={vi.fn()} onCreated={vi.fn()} onImported={vi.fn()} />
          <TourOverlay />
        </div>
      );
    };
    wrapper(<PageTourWithModal />);

    await waitFor(() => expect(screen.getByTestId('tour-overlay')).toBeInTheDocument());
    const modal = screen.getByText('Add Account').closest('[role="dialog"]');
    const tour = screen.getByTestId('tour-overlay');

    expect(modal).toHaveStyle({ zIndex: '110' });
    expect(tour).toHaveStyle({ zIndex: '100' });
  });

  it('has a concrete target for every modal tour step', () => {
    for (const tour of modalTourDefinitions) {
      for (const step of tour.steps) {
        expect(step.selector).toMatch(/^\[data-tour="[^"]+"\]$/);
        expect(step.note).toBeUndefined();
      }
    }
  });
});

describe('computePopoverPosition (popover positioning & viewport clamping)', () => {
  const viewport = { width: 1024, height: 768 };
  const popoverSize = { width: 340, height: 200 };

  const assertWithinViewport = (
    pos: { top: number; left: number },
    size = popoverSize,
    vp = viewport,
  ) => {
    expect(pos.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
    expect(pos.left + size.width).toBeLessThanOrEqual(vp.width - VIEWPORT_MARGIN);
    expect(pos.top).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
    expect(pos.top + size.height).toBeLessThanOrEqual(vp.height - VIEWPORT_MARGIN);
  };

  it('places popover to the right when target is at the left edge (mép trái)', () => {
    // Phần tử ở mép trái (ví dụ mục menu Tổng quan trên sidebar)
    const targetRect = { top: 180, left: 0, width: 68, height: 44 };
    const pos = computePopoverPosition(targetRect, popoverSize, viewport);

    expect(pos.placement).toBe('right');
    expect(pos.left).toBe(targetRect.left + targetRect.width + POPOVER_GAP);
    expect(pos.arrow).toBeDefined();
    expect(pos.arrow?.placement).toBe('left');
    assertWithinViewport(pos);
  });

  it('places popover below or on top when target is at the right edge (mép phải)', () => {
    // Phần tử ở mép phải: không đủ chỗ sang phải -> ưu tiên dưới
    const targetRectRight = { top: 120, left: 950, width: 60, height: 40 };
    const posBottom = computePopoverPosition(targetRectRight, popoverSize, viewport);

    expect(posBottom.placement).toBe('bottom');
    expect(posBottom.top).toBe(targetRectRight.top + targetRectRight.height + POPOVER_GAP);
    expect(posBottom.arrow).toBeDefined();
    expect(posBottom.arrow?.placement).toBe('top');
    assertWithinViewport(posBottom);

    // Phần tử ở góc dưới phải: không đủ chỗ sang phải và dưới -> ưu tiên trên
    const targetRectBottomRight = { top: 700, left: 960, width: 50, height: 40 };
    const posTop = computePopoverPosition(targetRectBottomRight, popoverSize, viewport);

    expect(posTop.placement).toBe('top');
    expect(posTop.top).toBe(targetRectBottomRight.top - POPOVER_GAP - popoverSize.height);
    expect(posTop.arrow).toBeDefined();
    expect(posTop.arrow?.placement).toBe('bottom');
    assertWithinViewport(posTop);

    // Phần tử cao chiếm hết lề phải: không đủ phải, dưới, trên -> chọn trái
    const targetRectTallRight = { top: 20, left: 960, width: 50, height: 720 };
    const posLeft = computePopoverPosition(targetRectTallRight, popoverSize, viewport);

    expect(posLeft.placement).toBe('left');
    expect(posLeft.left).toBe(targetRectTallRight.left - POPOVER_GAP - popoverSize.width);
    expect(posLeft.arrow).toBeDefined();
    expect(posLeft.arrow?.placement).toBe('right');
    assertWithinViewport(posLeft);
  });

  it('keeps popover strictly within viewport when target is at the top edge (mép trên)', () => {
    // 1. Phần tử ở mép trên có đủ chỗ sang phải: đặt bên phải và kẹp top >= VIEWPORT_MARGIN
    const targetRectTopLeft = { top: 0, left: 100, width: 80, height: 40 };
    const posRight = computePopoverPosition(targetRectTopLeft, popoverSize, viewport);
    expect(posRight.placement).toBe('right');
    expect(posRight.top).toBe(VIEWPORT_MARGIN); // clamped to top margin
    expect(posRight.left).toBe(targetRectTopLeft.left + targetRectTopLeft.width + POPOVER_GAP);
    assertWithinViewport(posRight);

    // 2. Phần tử ở mép trên sát góc phải: không đủ sang phải -> rơi xuống dưới
    const targetRectTopRight = { top: 0, left: 780, width: 220, height: 48 };
    const pos = computePopoverPosition(targetRectTopRight, popoverSize, viewport);

    expect(pos.placement).toBe('bottom');
    expect(pos.top).toBe(targetRectTopRight.top + targetRectTopRight.height + POPOVER_GAP);
    expect(pos.arrow?.placement).toBe('top');
    assertWithinViewport(pos);
  });

  it('places popover above target when target is at the bottom edge (mép dưới)', () => {
    // 1. Phần tử ở mép dưới có đủ chỗ sang phải: đặt bên phải và kẹp top <= maxTop
    const targetRectBottomLeft = { top: 740, left: 100, width: 80, height: 28 };
    const posRight = computePopoverPosition(targetRectBottomLeft, popoverSize, viewport);
    expect(posRight.placement).toBe('right');
    expect(posRight.top).toBe(viewport.height - VIEWPORT_MARGIN - popoverSize.height); // clamped to bottom margin
    assertWithinViewport(posRight);

    // 2. Phần tử ở mép dưới không đủ chỗ sang phải hoặc dưới: đặt phía trên
    const targetRectBottom = { top: 730, left: 750, width: 200, height: 32 };
    const pos = computePopoverPosition(targetRectBottom, popoverSize, viewport);

    expect(pos.placement).toBe('top');
    expect(pos.top).toBe(targetRectBottom.top - POPOVER_GAP - popoverSize.height);
    expect(pos.arrow?.placement).toBe('bottom');
    assertWithinViewport(pos);
  });

  it('handles narrow viewport (viewport hẹp) and falls back to bottom or bottom-sheet', () => {
    const mobileViewport = { width: 360, height: 640 };
    const mobilePopoverSize = { width: 336, height: 180 };

    // 1. Màn hẹp, phần tử ở trên: không đủ chỗ 2 bên -> đặt ở dưới và kẹp ngang
    const topTarget = { top: 30, left: 20, width: 140, height: 40 };
    const posBelow = computePopoverPosition(topTarget, mobilePopoverSize, mobileViewport);

    expect(posBelow.placement).toBe('bottom');
    expect(posBelow.top).toBe(topTarget.top + topTarget.height + POPOVER_GAP);
    expect(posBelow.left).toBe(VIEWPORT_MARGIN);
    assertWithinViewport(posBelow, mobilePopoverSize, mobileViewport);

    // 2. Màn hẹp, phần tử chiếm trung tâm không đủ chỗ ở mọi phía -> dạng bottom-sheet
    const tinyViewport = { width: 320, height: 480 };
    const tinyPopoverSize = { width: 296, height: 160 };
    const largeTarget = { top: 40, left: 10, width: 300, height: 380 };

    const posSheet = computePopoverPosition(largeTarget, tinyPopoverSize, tinyViewport);
    expect(posSheet.placement).toBe('bottom-sheet');
    expect(posSheet.top).toBe(tinyViewport.height - VIEWPORT_MARGIN - tinyPopoverSize.height);
    expect(posSheet.arrow).toBeUndefined();
    assertWithinViewport(posSheet, tinyPopoverSize, tinyViewport);
  });

  it('renders TourOverlay with spotlight, arrow, and interactive buttons', async () => {
    const target = document.createElement('div');
    target.setAttribute('data-tour', 'overview');
    Object.defineProperty(target, 'getBoundingClientRect', {
      value: () => ({ top: 80, left: 20, width: 100, height: 40, right: 120, bottom: 120, x: 20, y: 80 }),
    });
    document.body.appendChild(target);

    let startTour: ((id: string) => void) | undefined;
    const Probe = () => {
      const tour = useTour();
      startTour = tour.openTour;
      return <TourOverlay />;
    };

    wrapper(<Probe />);
    act(() => {
      startTour?.('intro');
    });

    await waitFor(() => {
      expect(screen.getByTestId('tour-spotlight')).toBeInTheDocument();
      expect(screen.getByTestId('tour-popover')).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: 'Close guide' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeInTheDocument();

    // Phím Escape đóng tour
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByTestId('tour-popover')).toBeNull();
    });

    document.body.removeChild(target);
  });

  it('updates popover and spotlight position on window resize, scroll, and transition events', async () => {
    const target = document.createElement('div');
    target.setAttribute('data-tour', 'overview');
    let targetRect = { top: 80, left: 20, width: 100, height: 40, right: 120, bottom: 120, x: 20, y: 80 };
    Object.defineProperty(target, 'getBoundingClientRect', {
      value: () => targetRect,
    });
    document.body.appendChild(target);

    let startTour: ((id: string) => void) | undefined;
    const Probe = () => {
      const tour = useTour();
      startTour = tour.openTour;
      return <TourOverlay />;
    };

    wrapper(<Probe />);
    act(() => {
      startTour?.('intro');
    });

    await waitFor(() => {
      expect(screen.getByTestId('tour-popover')).toBeInTheDocument();
    });

    // Mô phỏng target di chuyển và phát sự kiện cuộn/đổi cỡ
    targetRect = { top: 140, left: 50, width: 100, height: 40, right: 150, bottom: 180, x: 50, y: 140 };
    act(() => {
      window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('resize'));
    });

    await waitFor(() => {
      const spotlight = screen.getByTestId('tour-spotlight');
      expect(spotlight.style.top).toBe('136px'); // 140 - 4
      expect(spotlight.style.left).toBe('46px'); // 50 - 4
    });

    // Mô phỏng hiệu ứng chuyển cảnh hoàn tất (transitionend trên sidebar)
    targetRect = { top: 150, left: 60, width: 100, height: 40, right: 160, bottom: 190, x: 60, y: 150 };
    act(() => {
      window.dispatchEvent(new Event('transitionend'));
    });

    await waitFor(() => {
      const spotlight = screen.getByTestId('tour-spotlight');
      expect(spotlight.style.top).toBe('146px'); // 150 - 4
      expect(spotlight.style.left).toBe('56px'); // 60 - 4
    });

    document.body.removeChild(target);
  });
});
