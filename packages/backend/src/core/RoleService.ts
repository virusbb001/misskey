import { Inject, Injectable } from '@nestjs/common';
import Redis from 'ioredis';
import { In } from 'typeorm';
import type { Role, RoleAssignment, RoleAssignmentsRepository, RolesRepository, UsersRepository } from '@/models/index.js';
import { Cache } from '@/misc/cache.js';
import type { CacheableLocalUser, CacheableUser, ILocalUser, User } from '@/models/entities/User.js';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import { MetaService } from '@/core/MetaService.js';
import { UserCacheService } from '@/core/UserCacheService.js';
import type { RoleCondFormulaValue } from '@/models/entities/Role.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { StreamMessages } from '@/server/api/stream/types.js';
import type { OnApplicationShutdown } from '@nestjs/common';

export type RolePolicies = {
	gtlAvailable: boolean;
	ltlAvailable: boolean;
	canPublicNote: boolean;
	canInvite: boolean;
	canManageCustomEmojis: boolean;
	canHideAds: boolean;
	driveCapacityMb: number;
	pinLimit: number;
	antennaLimit: number;
	wordMuteLimit: number;
	webhookLimit: number;
	clipLimit: number;
	noteEachClipsLimit: number;
	userListLimit: number;
	userEachUserListsLimit: number;
	rateLimitFactor: number;
};

export const DEFAULT_POLICIES: RolePolicies = {
	gtlAvailable: true,
	ltlAvailable: true,
	canPublicNote: true,
	canInvite: false,
	canManageCustomEmojis: false,
	canHideAds: false,
	driveCapacityMb: 100,
	pinLimit: 5,
	antennaLimit: 5,
	wordMuteLimit: 200,
	webhookLimit: 3,
	clipLimit: 10,
	noteEachClipsLimit: 200,
	userListLimit: 10,
	userEachUserListsLimit: 50,
	rateLimitFactor: 1,
};

@Injectable()
export class RoleService implements OnApplicationShutdown {
	private rolesCache: Cache<Role[]>;
	private roleAssignmentByUserIdCache: Cache<RoleAssignment[]>;

	constructor(
		@Inject(DI.redisSubscriber)
		private redisSubscriber: Redis.Redis,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.rolesRepository)
		private rolesRepository: RolesRepository,

		@Inject(DI.roleAssignmentsRepository)
		private roleAssignmentsRepository: RoleAssignmentsRepository,

		private metaService: MetaService,
		private userCacheService: UserCacheService,
		private userEntityService: UserEntityService,
	) {
		//this.onMessage = this.onMessage.bind(this);

		this.rolesCache = new Cache<Role[]>(Infinity);
		this.roleAssignmentByUserIdCache = new Cache<RoleAssignment[]>(Infinity);

		this.redisSubscriber.on('message', this.onMessage);
	}

	@bindThis
	private async onMessage(_: string, data: string): Promise<void> {
		const obj = JSON.parse(data);

		if (obj.channel === 'internal') {
			const { type, body } = obj.message as StreamMessages['internal']['payload'];
			switch (type) {
				case 'roleCreated': {
					const cached = this.rolesCache.get(null);
					if (cached) {
						cached.push({
							...body,
							createdAt: new Date(body.createdAt),
							updatedAt: new Date(body.updatedAt),
							lastUsedAt: new Date(body.lastUsedAt),
						});
					}
					break;
				}
				case 'roleUpdated': {
					const cached = this.rolesCache.get(null);
					if (cached) {
						const i = cached.findIndex(x => x.id === body.id);
						if (i > -1) {
							cached[i] = {
								...body,
								createdAt: new Date(body.createdAt),
								updatedAt: new Date(body.updatedAt),
								lastUsedAt: new Date(body.lastUsedAt),
							};
						}
					}
					break;
				}
				case 'roleDeleted': {
					const cached = this.rolesCache.get(null);
					if (cached) {
						this.rolesCache.set(null, cached.filter(x => x.id !== body.id));
					}
					break;
				}
				case 'userRoleAssigned': {
					const cached = this.roleAssignmentByUserIdCache.get(body.userId);
					if (cached) {
						cached.push({
							...body,
							createdAt: new Date(body.createdAt),
						});
					}
					break;
				}
				case 'userRoleUnassigned': {
					const cached = this.roleAssignmentByUserIdCache.get(body.userId);
					if (cached) {
						this.roleAssignmentByUserIdCache.set(body.userId, cached.filter(x => x.id !== body.id));
					}
					break;
				}
				default:
					break;
			}
		}
	}

	@bindThis
	private evalCond(user: User, value: RoleCondFormulaValue): boolean {
		try {
			switch (value.type) {
				case 'and': {
					return value.values.every(v => this.evalCond(user, v));
				}
				case 'or': {
					return value.values.some(v => this.evalCond(user, v));
				}
				case 'not': {
					return !this.evalCond(user, value.value);
				}
				case 'isLocal': {
					return this.userEntityService.isLocalUser(user);
				}
				case 'isRemote': {
					return this.userEntityService.isRemoteUser(user);
				}
				case 'createdLessThan': {
					return user.createdAt.getTime() > (Date.now() - (value.sec * 1000));
				}
				case 'createdMoreThan': {
					return user.createdAt.getTime() < (Date.now() - (value.sec * 1000));
				}
				case 'followersLessThanOrEq': {
					return user.followersCount <= value.value;
				}
				case 'followersMoreThanOrEq': {
					return user.followersCount >= value.value;
				}
				case 'followingLessThanOrEq': {
					return user.followingCount <= value.value;
				}
				case 'followingMoreThanOrEq': {
					return user.followingCount >= value.value;
				}
				default:
					return false;
			}
		} catch (err) {
			// TODO: log error
			return false;
		}
	}

	@bindThis
	public async getUserRoles(userId: User['id']) {
		const assigns = await this.roleAssignmentByUserIdCache.fetch(userId, () => this.roleAssignmentsRepository.findBy({ userId }));
		const assignedRoleIds = assigns.map(x => x.roleId);
		const roles = await this.rolesCache.fetch(null, () => this.rolesRepository.findBy({}));
		const assignedRoles = roles.filter(r => assignedRoleIds.includes(r.id));
		const user = roles.some(r => r.target === 'conditional') ? await this.userCacheService.findById(userId) : null;
		const matchedCondRoles = roles.filter(r => r.target === 'conditional' && this.evalCond(user!, r.condFormula));
		return [...assignedRoles, ...matchedCondRoles];
	}

	/**
	 * 指定ユーザーのバッジロール一覧取得
	 */
	@bindThis
	public async getUserBadgeRoles(userId: User['id']) {
		const assigns = await this.roleAssignmentByUserIdCache.fetch(userId, () => this.roleAssignmentsRepository.findBy({ userId }));
		const assignedRoleIds = assigns.map(x => x.roleId);
		const roles = await this.rolesCache.fetch(null, () => this.rolesRepository.findBy({}));
		const assignedBadgeRoles = roles.filter(r => r.asBadge && assignedRoleIds.includes(r.id));
		// コンディショナルロールも含めるのは負荷高そうだから一旦無し
		return assignedBadgeRoles;
	}

	@bindThis
	public async getUserPolicies(userId: User['id'] | null): Promise<RolePolicies> {
		const meta = await this.metaService.fetch();
		const basePolicies = { ...DEFAULT_POLICIES, ...meta.policies };

		if (userId == null) return basePolicies;

		const roles = await this.getUserRoles(userId);

		function calc<T extends keyof RolePolicies>(name: T, aggregate: (values: RolePolicies[T][]) => RolePolicies[T]) {
			if (roles.length === 0) return basePolicies[name];

			const policies = roles.map(role => role.policies[name] ?? { priority: 0, useDefault: true });

			const p2 = policies.filter(policy => policy.priority === 2);
			if (p2.length > 0) return aggregate(p2.map(policy => policy.useDefault ? basePolicies[name] : policy.value));

			const p1 = policies.filter(policy => policy.priority === 1);
			if (p1.length > 0) return aggregate(p1.map(policy => policy.useDefault ? basePolicies[name] : policy.value));

			return aggregate(policies.map(policy => policy.useDefault ? basePolicies[name] : policy.value));
		}

		return {
			gtlAvailable: calc('gtlAvailable', vs => vs.some(v => v === true)),
			ltlAvailable: calc('ltlAvailable', vs => vs.some(v => v === true)),
			canPublicNote: calc('canPublicNote', vs => vs.some(v => v === true)),
			canInvite: calc('canInvite', vs => vs.some(v => v === true)),
			canManageCustomEmojis: calc('canManageCustomEmojis', vs => vs.some(v => v === true)),
			canHideAds: calc('canHideAds', vs => vs.some(v => v === true)),
			driveCapacityMb: calc('driveCapacityMb', vs => Math.max(...vs)),
			pinLimit: calc('pinLimit', vs => Math.max(...vs)),
			antennaLimit: calc('antennaLimit', vs => Math.max(...vs)),
			wordMuteLimit: calc('wordMuteLimit', vs => Math.max(...vs)),
			webhookLimit: calc('webhookLimit', vs => Math.max(...vs)),
			clipLimit: calc('clipLimit', vs => Math.max(...vs)),
			noteEachClipsLimit: calc('noteEachClipsLimit', vs => Math.max(...vs)),
			userListLimit: calc('userListLimit', vs => Math.max(...vs)),
			userEachUserListsLimit: calc('userEachUserListsLimit', vs => Math.max(...vs)),
			rateLimitFactor: calc('rateLimitFactor', vs => Math.max(...vs)),
		};
	}

	@bindThis
	public async isModerator(user: { id: User['id']; isRoot: User['isRoot'] } | null): Promise<boolean> {
		if (user == null) return false;
		return user.isRoot || (await this.getUserRoles(user.id)).some(r => r.isModerator || r.isAdministrator);
	}

	@bindThis
	public async isAdministrator(user: { id: User['id']; isRoot: User['isRoot'] } | null): Promise<boolean> {
		if (user == null) return false;
		return user.isRoot || (await this.getUserRoles(user.id)).some(r => r.isAdministrator);
	}

	@bindThis
	public async getModeratorIds(includeAdmins = true): Promise<User['id'][]> {
		const roles = await this.rolesCache.fetch(null, () => this.rolesRepository.findBy({}));
		const moderatorRoles = includeAdmins ? roles.filter(r => r.isModerator || r.isAdministrator) : roles.filter(r => r.isModerator);
		const assigns = moderatorRoles.length > 0 ? await this.roleAssignmentsRepository.findBy({
			roleId: In(moderatorRoles.map(r => r.id)),
		}) : [];
		// TODO: isRootなアカウントも含める
		return assigns.map(a => a.userId);
	}

	@bindThis
	public async getModerators(includeAdmins = true): Promise<User[]> {
		const ids = await this.getModeratorIds(includeAdmins);
		const users = ids.length > 0 ? await this.usersRepository.findBy({
			id: In(ids),
		}) : [];
		return users;
	}

	@bindThis
	public async getAdministratorIds(): Promise<User['id'][]> {
		const roles = await this.rolesCache.fetch(null, () => this.rolesRepository.findBy({}));
		const administratorRoles = roles.filter(r => r.isAdministrator);
		const assigns = administratorRoles.length > 0 ? await this.roleAssignmentsRepository.findBy({
			roleId: In(administratorRoles.map(r => r.id)),
		}) : [];
		// TODO: isRootなアカウントも含める
		return assigns.map(a => a.userId);
	}

	@bindThis
	public async getAdministrators(): Promise<User[]> {
		const ids = await this.getAdministratorIds();
		const users = ids.length > 0 ? await this.usersRepository.findBy({
			id: In(ids),
		}) : [];
		return users;
	}

	@bindThis
	public onApplicationShutdown(signal?: string | undefined) {
		this.redisSubscriber.off('message', this.onMessage);
	}
}
