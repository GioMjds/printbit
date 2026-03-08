import { AdminSettings } from '@/domain/entities';

export interface IAdminSettingsRepository {
	get(): Promise<AdminSettings>;
	save(settings: AdminSettings): Promise<void>;
}
