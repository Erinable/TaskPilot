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
import type * as masteryTypes from '@shared/ipc/mastery.ts';

export const useMasteryStore = defineStore('mastery', () => {
  // ========== Course ==========
  const course = ref<masteryTypes.CourseMastery | null>(null);
  // The pack picked on the page; null follows the one in use.
  const courseId = ref<string | null>(null);
  const selected = ref<string | null>(null);

  const loadCourse = async (id: string | null = courseId.value) => {
    try {
      course.value = await call(window.taskpilot.mastery.course(id ?? undefined));
      courseId.value = id;
      if (selected.value && !course.value.concepts.some((concept) => concept.id === selected.value)) selected.value = null;
    } catch (error) {
      console.error('[mastery] course failed', error);
      showToast(`读取掌握度失败：${describeError(error)}`);
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

  // Opens the mastery page on a pack.
  const openCourse = async (id: string) => {
    courseId.value = id;
    selected.value = null;
    await useAppStore().navigate('mastery');
  };

  // ========== Review ==========
  const reviews = ref<masteryTypes.ReviewList | null>(null);
  const reviewing = ref<string | null>(null);

  const loadReviews = async () => {
    try {
      reviews.value = await call(window.taskpilot.mastery.reviews());
    } catch (error) {
      console.error('[mastery] reviews failed', error);
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

  // The pack in use may change with the repository.
  const reset = () => {
    course.value = null;
    courseId.value = null;
    selected.value = null;
    summary.value = null;
  };

  return {
    // Course
    course,
    courseId,
    selected,
    loadCourse,
    select,
    // Course summary
    summary,
    loadSummary,
    openCourse,
    // Review
    reviews,
    reviewing,
    loadReviews,
    review,
    // Page
    load,
    reset,
  };
});
