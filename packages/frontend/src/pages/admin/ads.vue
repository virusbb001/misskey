<template>
<MkStickyContainer>
	<template #header><XHeader :actions="headerActions" :tabs="headerTabs"/></template>
	<MkSpacer :content-max="900">
		<div class="uqshojas">
			<div v-for="ad in ads" class="_panel _gaps_m ad">
				<MkAd v-if="ad.url" :specify="ad"/>
				<MkInput v-model="ad.url" type="url">
					<template #label>URL</template>
				</MkInput>
				<MkInput v-model="ad.imageUrl">
					<template #label>{{ i18n.ts.imageUrl }}</template>
				</MkInput>
				<MkRadios v-model="ad.place">
					<template #label>Form</template>
					<option value="square">square</option>
					<option value="horizontal">horizontal</option>
					<option value="horizontal-big">horizontal-big</option>
				</MkRadios>
				<!--
			<div style="margin: 32px 0;">
				{{ i18n.ts.priority }}
				<MkRadio v-model="ad.priority" value="high">{{ i18n.ts.high }}</MkRadio>
				<MkRadio v-model="ad.priority" value="middle">{{ i18n.ts.middle }}</MkRadio>
				<MkRadio v-model="ad.priority" value="low">{{ i18n.ts.low }}</MkRadio>
			</div>
			-->
				<FormSplit>
					<MkInput v-model="ad.ratio" type="number">
						<template #label>{{ i18n.ts.ratio }}</template>
					</MkInput>
					<MkInput v-model="ad.expiresAt" type="datetime-local">
						<template #label>{{ i18n.ts.expiration }}</template>
					</MkInput>
				</FormSplit>
				<MkTextarea v-model="ad.memo">
					<template #label>{{ i18n.ts.memo }}</template>
				</MkTextarea>
				<div class="buttons">
					<MkButton class="button" inline primary style="margin-right: 12px;" @click="save(ad)"><i class="ti ti-device-floppy"></i> {{ i18n.ts.save }}</MkButton>
					<MkButton class="button" inline danger @click="remove(ad)"><i class="ti ti-trash"></i> {{ i18n.ts.remove }}</MkButton>
				</div>
			</div>
		</div>
	</MkSpacer>
</MkStickyContainer>
</template>

<script lang="ts" setup>
import { } from 'vue';
import XHeader from './_header_.vue';
import MkButton from '@/components/MkButton.vue';
import MkInput from '@/components/MkInput.vue';
import MkTextarea from '@/components/MkTextarea.vue';
import MkRadios from '@/components/MkRadios.vue';
import FormSplit from '@/components/form/split.vue';
import * as os from '@/os';
import { i18n } from '@/i18n';
import { definePageMetadata } from '@/scripts/page-metadata';

let ads: any[] = $ref([]);

os.api('admin/ad/list').then(adsResponse => {
	ads = adsResponse.map(r => {
		return {
			...r,
			expiresAt: new Date(r.expiresAt).toISOString().slice(0, 16),
		};
	});
});

function add() {
	ads.unshift({
		id: null,
		memo: '',
		place: 'square',
		priority: 'middle',
		ratio: 1,
		url: '',
		imageUrl: null,
		expiresAt: null,
	});
}

function remove(ad) {
	os.confirm({
		type: 'warning',
		text: i18n.t('removeAreYouSure', { x: ad.url }),
	}).then(({ canceled }) => {
		if (canceled) return;
		ads = ads.filter(x => x !== ad);
		os.apiWithDialog('admin/ad/delete', {
			id: ad.id,
		});
	});
}

function save(ad) {
	if (ad.id == null) {
		os.apiWithDialog('admin/ad/create', {
			...ad,
			expiresAt: new Date(ad.expiresAt).getTime(),
		});
	} else {
		os.apiWithDialog('admin/ad/update', {
			...ad,
			expiresAt: new Date(ad.expiresAt).getTime(),
		});
	}
}

const headerActions = $computed(() => [{
	asFullButton: true,
	icon: 'ti ti-plus',
	text: i18n.ts.add,
	handler: add,
}]);

const headerTabs = $computed(() => []);

definePageMetadata({
	title: i18n.ts.ads,
	icon: 'ti ti-ad',
});
</script>

<style lang="scss" scoped>
.uqshojas {
	> .ad {
		padding: 32px;

		&:not(:last-child) {
			margin-bottom: var(--margin);
		}
	}
}
</style>
