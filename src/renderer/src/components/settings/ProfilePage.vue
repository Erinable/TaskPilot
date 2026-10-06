<script setup lang="ts">
import { nextTick, ref } from 'vue';

import AppIcon from '@/components/AppIcon.vue';
import UserAvatar from '@/components/UserAvatar.vue';
import { AVATAR_COLOR_NAMES } from '@/lib/avatar.ts';
import type { AvatarColor } from '@/lib/avatar.ts';
import { MAX_NAME_LENGTH, useSettingsStore } from '@/stores/settings.ts';
import FieldStatus from './FieldStatus.vue';

const settings = useSettingsStore();

const AVATAR_LABELS: Record<AvatarColor, string> = { sunset: '日落', ocean: '海洋', violet: '紫罗兰', forest: '森林', graphite: '石墨' };
const swatches = ref<HTMLElement | null>(null);

const pickColor = async (color: AvatarColor) => {
  if (!settings.preferencesDraft) return;
  settings.preferencesDraft.profile.avatarColor = color;
  await nextTick();
  swatches.value?.querySelector<HTMLElement>(`[data-color="${color}"]`)?.focus();
};

const onPick = (color: AvatarColor) => {
  pickColor(color).catch((error) => console.error(error));
};

// Arrow keys move through the radiogroup, as for native radios.
const onSwatchKeydown = (event: KeyboardEvent) => {
  const step = ({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 } as Record<string, number>)[event.key];
  if (!step || !settings.preferencesDraft) return;
  event.preventDefault();
  const colors = AVATAR_COLOR_NAMES;
  const index = colors.indexOf(settings.preferencesDraft.profile.avatarColor);
  onPick(colors[(index + step + colors.length) % colors.length]);
};

const onNameInput = (value: string) => {
  if (!settings.preferencesDraft) return;
  settings.preferencesDraft.profile.displayName = value;
  settings.checkNameLength();
};
</script>

<template>
  <header class="settings-page-header">
    <h2>个人资料</h2>
    <span class="scope-badge">
      <AppIcon name="laptop" />
      仅保存在本机
    </span>
  </header>
  <h3 class="settings-section-title">个人信息</h3>
  <div v-if="settings.preferencesDraft" class="settings-card glass">
    <div class="setting-row">
      <div class="setting-label">
        <strong>头像</strong>
        <small>显示在顶栏，文字取自你的名字</small>
      </div>
      <div class="setting-control avatar-control">
        <div id="avatarSwatches" ref="swatches" class="avatar-swatches" role="radiogroup" aria-label="头像颜色" @keydown="onSwatchKeydown">
          <button
            v-for="color in AVATAR_COLOR_NAMES"
            :key="color"
            type="button"
            class="avatar-swatch"
            :class="color"
            :data-color="color"
            role="radio"
            :aria-checked="color === settings.preferencesDraft.profile.avatarColor ? 'true' : 'false'"
            :aria-label="AVATAR_LABELS[color]"
            :tabindex="color === settings.preferencesDraft.profile.avatarColor ? 0 : -1"
            @click="onPick(color)"
          ></button>
        </div>
        <UserAvatar
          id="profileAvatarPreview"
          class="avatar large"
          :display-name="settings.preferencesDraft.profile.displayName"
          :avatar-color="settings.preferencesDraft.profile.avatarColor"
        />
      </div>
    </div>
    <div class="setting-row">
      <label class="setting-label" for="profileName">
        <strong>名字</strong>
        <small>用于首页问候语</small>
      </label>
      <div class="setting-control">
        <el-input
          id="profileName"
          :model-value="settings.preferencesDraft.profile.displayName"
          name="displayName"
          autocomplete="name"
          placeholder="怎么称呼你"
          aria-describedby="profileNameStatus"
          :aria-invalid="String(settings.statuses.displayName.tone === 'error')"
          @update:model-value="onNameInput"
        />
        <div class="field-meta">
          <FieldStatus id="profileNameStatus" :status="settings.statuses.displayName" />
          <span id="profileNameCount" class="char-count" :class="{ over: settings.nameLength > MAX_NAME_LENGTH }">
            {{ settings.nameLength }}/{{ MAX_NAME_LENGTH }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>
