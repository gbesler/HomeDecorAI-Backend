export interface RateLimitConfig {
  minuteLimit: number;
  hourlyLimit: number;
  dailyLimit: number;
}

export const rateLimits: Record<string, RateLimitConfig> = {
  interiorDesign: {
    minuteLimit: 5,
    hourlyLimit: 30,
    dailyLimit: 100,
  },
};
