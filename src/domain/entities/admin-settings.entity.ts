import { ValidationException } from '@/domain/errors';

export interface PricingSettings {
	printPerPage: number;
	copyPerPage: number;
	scanDocument: number;
	colorSurcharge: number;
}

export interface HopperSettings {
	enabled: boolean;
	timeoutMs: number;
	retryCount: number;
	dispenseCommandPrefix: string;
	selfTestCommand: string;
}

export interface AdminSettingsProps {
	pricing: PricingSettings;
	idleTimeoutSeconds: number;
	adminPin: string;
	adminLocalOnly: boolean;
	hopper: HopperSettings;
}

export class AdminSettings {
	private constructor(private readonly props: AdminSettingsProps) {}

	static create(props: AdminSettingsProps): AdminSettings {
		this.validatePricing(props.pricing);
		this.validatePin(props.adminPin);
		if (!Number.isInteger(props.idleTimeoutSeconds) || props.idleTimeoutSeconds <= 0) {
			throw new ValidationException('idleTimeoutSeconds must be a positive integer.');
		}
		return new AdminSettings({ ...props });
	}

	updatePricing(pricing: PricingSettings): AdminSettings {
		AdminSettings.validatePricing(pricing);
		return new AdminSettings({ ...this.props, pricing: { ...pricing } });
	}

	updatePin(adminPin: string): AdminSettings {
		AdminSettings.validatePin(adminPin);
		return new AdminSettings({ ...this.props, adminPin });
	}

	updateHopperConfig(hopper: HopperSettings): AdminSettings {
		return new AdminSettings({ ...this.props, hopper: { ...hopper } });
	}

	toPrimitives(): AdminSettingsProps {
		return {
			pricing: { ...this.props.pricing },
			idleTimeoutSeconds: this.props.idleTimeoutSeconds,
			adminPin: this.props.adminPin,
			adminLocalOnly: this.props.adminLocalOnly,
			hopper: { ...this.props.hopper },
		};
	}

	private static validatePricing(pricing: PricingSettings): void {
		const values = [
			pricing.printPerPage,
			pricing.copyPerPage,
			pricing.scanDocument,
			pricing.colorSurcharge,
		];
		for (const value of values) {
			if (!Number.isInteger(value) || value < 0) {
				throw new ValidationException('Pricing values must be non-negative integers.');
			}
		}
	}

	private static validatePin(pin: string): void {
		if (!/^\d{4,8}$/.test(pin)) {
			throw new ValidationException('Admin PIN must be 4 to 8 digits.');
		}
	}
}
