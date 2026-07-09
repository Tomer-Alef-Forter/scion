// Copied from Superset (packages/ui/src/lib/utils.ts). See NOTICE.md.
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}
