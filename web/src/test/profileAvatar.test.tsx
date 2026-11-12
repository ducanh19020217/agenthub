import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ProfileAvatar, avatarObjectUrlCache, AVATAR_RETRY_DELAY_MS } from '../pages/ProfilesPage';
import * as client from '../api/client';
import { Profile } from '../types/api';

describe('ProfileAvatar Component', () => {
  let createdObjectUrls: string[] = [];
  let revokedObjectUrls: string[] = [];

  beforeEach(() => {
    sessionStorage.clear();
    client.setToken('test_auth_token_xyz');
    avatarObjectUrlCache.clear();
    createdObjectUrls = [];
    revokedObjectUrls = [];

    let urlCounter = 0;
    URL.createObjectURL = vi.fn().mockImplementation(() => {
      const url = `blob:http://localhost/mock-avatar-blob-${++urlCounter}`;
      createdObjectUrls.push(url);
      return url;
    });

    URL.revokeObjectURL = vi.fn().mockImplementation((url: string) => {
      revokedObjectUrls.push(url);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    avatarObjectUrlCache.clear();
  });

  it('gọi endpoint /api/profiles/:name/avatar có Bearer auth và render img với src blob:...', async () => {
    let capturedUrl = '';
    let capturedHeaders: Headers | undefined;

    vi.spyOn(window, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedHeaders = new Headers(init?.headers);
      return new Response(new Blob(['fake-image'], { type: 'image/jpeg' }), {
        status: 200,
        headers: { 'Content-Type': 'image/jpeg' },
      });
    });

    const profile: Profile = {
      name: 'g1',
      engine: 'agy',
      kind: 'isolated',
      email: 'g1@example.com',
      avatarUrl: 'https://lh3.googleusercontent.com/a/mock-g1',
      enabled: 1,
    };

    render(<ProfileAvatar profile={profile} />);

    // Wait for the img to appear
    const img = await screen.findByRole('img');
    expect(img).toBeInTheDocument();
    expect(img.getAttribute('src')).toMatch(/^blob:/);
    expect(img.getAttribute('src')).not.toContain('googleusercontent.com');

    // Verify endpoint and auth header
    expect(capturedUrl).toBe('/api/profiles/g1/avatar');
    expect(capturedHeaders?.get('Authorization')).toBe('Bearer test_auth_token_xyz');
  });

  it('hiển thị avatar chữ cái khi profile không có avatarUrl và không gọi fetch', async () => {
    const fetchSpy = vi.spyOn(window, 'fetch');
    const profile: Profile = {
      name: 'codex-worker',
      engine: 'codex',
      kind: 'codex',
      email: 'codex@example.com',
      avatarUrl: null,
      enabled: 1,
    };

    render(<ProfileAvatar profile={profile} />);

    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('C')).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('hiển thị avatar chữ cái khi tải avatar qua proxy thất bại', async () => {
    vi.spyOn(client, 'getProfileAvatarBlob').mockRejectedValue(new Error('502 Bad Gateway'));

    const profile: Profile = {
      name: 'broken-avatar-profile',
      engine: 'agy',
      kind: 'isolated',
      email: 'broken@example.com',
      avatarUrl: 'https://lh3.googleusercontent.com/a/broken',
      enabled: 1,
    };

    render(<ProfileAvatar profile={profile} />);

    // Initially or upon error, it displays the initial letter 'B'
    expect(await screen.findByText('B')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('thử lại sau một khoảng (30s) khi tải lỗi thay vì bỏ hẳn', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    let callCount = 0;
    vi.spyOn(client, 'getProfileAvatarBlob').mockImplementation(async () => {
      callCount++;
      if (callCount < 3) {
        throw new Error('502 Bad Gateway');
      }
      return new Blob(['fake-image'], { type: 'image/png' });
    });

    const profile: Profile = {
      name: 'retry-profile',
      engine: 'agy',
      kind: 'isolated',
      email: 'retry@example.com',
      avatarUrl: 'https://lh3.googleusercontent.com/a/retry',
      enabled: 1,
    };

    render(<ProfileAvatar profile={profile} />);

    // First attempt fails immediately
    await act(async () => {
      await Promise.resolve();
    });
    expect(callCount).toBe(1);
    expect(screen.queryByRole('img')).toBeNull();

    // Fast-forward 30s for first retry
    await act(async () => {
      vi.advanceTimersByTime(AVATAR_RETRY_DELAY_MS);
      await Promise.resolve();
    });
    expect(callCount).toBe(2);

    // Fast-forward another 30s for second retry (succeeds)
    await act(async () => {
      vi.advanceTimersByTime(AVATAR_RETRY_DELAY_MS);
      await Promise.resolve();
    });
    expect(callCount).toBe(3);

    vi.useRealTimers();

    const img = await screen.findByRole('img');
    expect(img).toBeInTheDocument();
    expect(img.getAttribute('src')).toMatch(/^blob:/);
  });

  it('thu hồi objectURL (revokeObjectURL) khi unmount component', async () => {
    vi.spyOn(client, 'getProfileAvatarBlob').mockResolvedValue(
      new Blob(['fake-image'], { type: 'image/jpeg' }),
    );

    const profile: Profile = {
      name: 'unmount-test',
      engine: 'agy',
      kind: 'isolated',
      email: 'unmount@example.com',
      avatarUrl: 'https://lh3.googleusercontent.com/a/unmount',
      enabled: 1,
    };

    const { unmount } = render(<ProfileAvatar profile={profile} />);

    await screen.findByRole('img');
    expect(createdObjectUrls.length).toBe(1);
    const createdUrl = createdObjectUrls[0];

    expect(revokedObjectUrls).not.toContain(createdUrl);

    unmount();

    expect(revokedObjectUrls).toContain(createdUrl);
    expect(avatarObjectUrlCache.size).toBe(0);
  });

  it('dùng cache module: nhiều component cùng hồ sơ chỉ gọi API fetch 1 lần', async () => {
    const fetchBlobSpy = vi.spyOn(client, 'getProfileAvatarBlob').mockResolvedValue(
      new Blob(['fake-image'], { type: 'image/jpeg' }),
    );

    const profile: Profile = {
      name: 'shared-profile',
      engine: 'agy',
      kind: 'isolated',
      email: 'shared@example.com',
      avatarUrl: 'https://lh3.googleusercontent.com/a/shared',
      enabled: 1,
    };

    const { unmount } = render(
      <div>
        <ProfileAvatar profile={profile} />
        <ProfileAvatar profile={profile} />
      </div>,
    );

    const imgs = await screen.findAllByRole('img');
    expect(imgs.length).toBe(2);
    expect(imgs[0].getAttribute('src')).toBe(imgs[1].getAttribute('src'));
    expect(fetchBlobSpy).toHaveBeenCalledTimes(1);

    unmount();
    expect(avatarObjectUrlCache.size).toBe(0);
  });

  it('tự làm mới và đổi blob khi avatarUrl của profile thay đổi', async () => {
    vi.spyOn(client, 'getProfileAvatarBlob').mockResolvedValue(
      new Blob(['fake-image'], { type: 'image/jpeg' }),
    );

    const profile1: Profile = {
      name: 'change-profile',
      engine: 'agy',
      kind: 'isolated',
      email: 'change@example.com',
      avatarUrl: 'https://lh3.googleusercontent.com/a/url-1',
      enabled: 1,
    };

    const { rerender } = render(<ProfileAvatar profile={profile1} />);

    const img1 = await screen.findByRole('img');
    const firstSrc = img1.getAttribute('src');
    expect(firstSrc).toMatch(/^blob:/);

    // Change avatarUrl
    const profile2: Profile = {
      ...profile1,
      avatarUrl: 'https://lh3.googleusercontent.com/a/url-2',
    };

    rerender(<ProfileAvatar profile={profile2} />);

    const img2 = await screen.findByRole('img');
    const secondSrc = img2.getAttribute('src');
    expect(secondSrc).toMatch(/^blob:/);
    expect(secondSrc).not.toBe(firstSrc);
    expect(revokedObjectUrls).toContain(firstSrc);
  });
});
