// The mastery page: one course pack's concepts and how each stands, the
// notes due for review today, and the learner's verdict on one. Mastery is
// global (userData/mastery.json), so nothing here resets on a repository
// switch beyond the pack in use.
import { defineStore } from 'pinia';
import { ref } from 'vue';

import { call } from '@/lib/ipc.ts';
import { describeError } from '@/lib/errors.ts';
import { showToast } from '@/lib/feedback.ts';
import { useAppStore } from './app.ts';
import { createStateWatcher } from './state_watcher.ts';
import type * as masteryTypes from '@shared/ipc/mastery.ts';

export const useMasteryStore = defineStore('mastery', () => {
  // ========== Course ==========
  const course = ref<masteryTypes.CourseMastery | null>(null);
  // The pack picked on the page; null follows the one in use.
  const courseId = ref<string | null>(null);
  const selected = ref<string | null>(null);
  // Why the page's course could not be read; the page offers a retry.
  const courseError = ref<string | null>(null);
  const courseLoading = ref(false);
  // Bumped by every course read and by reset(): only the latest answer applies.
  let courseGeneration = 0;

  const loadCourse = async (id: string | null = courseId.value) => {
    const token = ++courseGeneration;
    // Set before the read, so a refresh from an event asks for the same pack.
    courseId.value = id;
    courseLoading.value = true;
    try {
      const next = await call(window.taskpilot.mastery.course(id ?? undefined));
      if (token !== courseGeneration) return;
      course.value = next;
      courseError.value = null;
      if (selected.value && !next.concepts.some((concept) => concept.id === selected.value)) selected.value = null;
    } catch (error) {
      if (token !== courseGeneration) return;
      console.error('[mastery] course failed', error);
      courseError.value = describeError(error);
      showToast(`读取掌握度失败：${describeError(error)}`);
    } finally {
      if (token === courseGeneration) courseLoading.value = false;
    }
  };

  const select = (conceptId: string | null) => {
    selected.value = conceptId;
  };

  // ========== Course summary ==========
  // The 课程 view's summary of the pack it shows: its lab repositories and
  // how its concepts stand. Kept apart from the page's own course.
  const summary = ref<masteryTypes.CourseMastery | null>(null);

  const loadSummary = async (id: string) => {
    try {
      const loaded = await call(window.taskpilot.mastery.course(id));
      summary.value = loaded;
    } catch (error) {
      // The pack itself still shows; only its summary is missing.
      console.error('[mastery] summary failed', error);
      summary.value = null;
    }
  };

  // Opens the mastery page on a pack, with one of its concepts picked.
  const openCourse = async (id: string, conceptId: string | null = null) => {
    courseId.value = id;
    selected.value = conceptId;
    await useAppStore().navigate('mastery');
  };

  // ========== Review ==========
  const reviews = ref<masteryTypes.ReviewList | null>(null);
  const reviewing = ref<string | null>(null);
  const reviewsError = ref<string | null>(null);
  let reviewsGeneration = 0;

  const loadReviews = async () => {
    const token = ++reviewsGeneration;
    try {
      const next = await call(window.taskpilot.mastery.reviews());
      if (token !== reviewsGeneration) return;
      reviews.value = next;
      reviewsError.value = null;
    } catch (error) {
      if (token !== reviewsGeneration) return;
      console.error('[mastery] reviews failed', error);
      reviewsError.value = describeError(error);
      showToast(`读取复习列表失败：${describeError(error)}`);
    }
  };

  // Remembered moves the note up a box, forgotten back to box 1.
  const review = async (noteId: string, remembered: boolean) => {
    reviewing.value = noteId;
    try {
      const next = await call(window.taskpilot.mastery.review(noteId, remembered));
      showToast(remembered ? `记住了，下次复习在 ${next.dueDay}。` : `回到第 1 档，${next.dueDay} 再复习。`);
      await loadReviews();
    } catch (error) {
      console.error('[mastery] review failed', error);
      showToast(`保存自评失败：${describeError(error)}`);
    } finally {
      reviewing.value = null;
    }
  };

  const load = () => Promise.all([loadCourse(), loadReviews()]);

  // ========== State events ==========
  // Mastery and notes are global, but the pack in use follows the open
  // repository, so its events are read too while the page is open.
  const watcher = createStateWatcher({
    name: 'mastery',
    domains: ['mastery', 'notes', 'courses'],
    global: true,
    initialRead: false,
    read: async () => {
      await load();
    },
  });

  const enter = async () => {
    await watcher.start();
    await load();
  };

  const leave = () => watcher.stop();

  // The pack in use may change with the repository.
  const reset = () => {
    watcher.stop();
    courseGeneration += 1;
    reviewsGeneration += 1;
    course.value = null;
    courseId.value = null;
    courseError.value = null;
    courseLoading.value = false;
    selected.value = null;
    summary.value = null;
    reviewsError.value = null;
  };

  return {
    // Course
    course,
    courseId,
    selected,
    courseError,
    courseLoading,
    loadCourse,
    select,
    // Course summary
    summary,
    loadSummary,
    openCourse,
    // Review
    reviews,
    reviewing,
    reviewsError,
    loadReviews,
    review,
    // Page
    load,
    enter,
    leave,
    reset,
  };
});
