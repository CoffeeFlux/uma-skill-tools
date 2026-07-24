import { Region, RegionList } from './Region';
import { PRNG } from './Random';

export interface ActivationSamplePolicy {
	sample(regions: RegionList, nsamples: number, rng: PRNG): Region[]

	// essentially, when two conditions are combined with an AndOperator one should take precedence over the other
	// immediate transitions into anything and straight_random/all_corner_random dominate everything except each other
	// NB. currently there are no skills that combine straight_random or all_corner_random with anything other than
	// immediate conditions (running_style or distance_type), and obviously they are mutually exclusive with each other
	// the actual x_random (phase_random, down_slope_random, etc) ones should dominate the ones that are not actually
	// random but merely modeled with a probability distribution. two distribution-modeled conditions combine into a
	// BothRandomPolicy (see below).
	// use smalltalk-style double dispatch to implement the transitions
	reconcile(other: ActivationSamplePolicy): ActivationSamplePolicy
	reconcileImmediate(other: ActivationSamplePolicy): ActivationSamplePolicy
	reconcileDistributionRandom(other: ActivationSamplePolicy): ActivationSamplePolicy
	reconcileRandom(other: ActivationSamplePolicy): ActivationSamplePolicy
	reconcileStraightRandom(other: ActivationSamplePolicy): ActivationSamplePolicy
	reconcileAllCornerRandom(other: ActivationSamplePolicy): ActivationSamplePolicy

	// OrOperator combines policies with this instead of reconcile; conjunction and disjunction need different
	// treatment (see DistributionRandomPolicy#reconcileOr). for everything else it's the same as reconcile.
	reconcileOr(other: ActivationSamplePolicy): ActivationSamplePolicy
}

export const ImmediatePolicy = Object.freeze({
	sample(regions: RegionList, _0: number, _1: PRNG) { return regions.slice(0,1); },
	reconcile(other: ActivationSamplePolicy) { return other.reconcileImmediate(this); },
	reconcileImmediate(other: ActivationSamplePolicy) { return other; },
	reconcileDistributionRandom(other: ActivationSamplePolicy) { return other; },
	reconcileRandom(other: ActivationSamplePolicy) { return other; },
	reconcileStraightRandom(other: ActivationSamplePolicy) { return other; },
	reconcileAllCornerRandom(other: ActivationSamplePolicy) { return other; },
	reconcileOr(other: ActivationSamplePolicy) { return this.reconcile(other); }
});

export const RandomPolicy = Object.freeze({
	sample(regions: RegionList, nsamples: number, rng: PRNG) {
		if (regions.length == 0) {
			return [];
		}
		let acc = 0;
		const weights = regions.map(r => acc += r.end - r.start);
		const samples = [];
		for (let i = 0; i < nsamples; ++i) {
			const threshold = rng.uniform(acc);
			const region = regions.find((_,i) => weights[i] > threshold)!;
			samples.push(region.start + rng.uniform(region.end - region.start - 10));
		}
		return samples.map(pos => new Region(pos, pos + 10));
	},
	reconcile(other: ActivationSamplePolicy) { return other.reconcileRandom(this); },
	reconcileImmediate(_: ActivationSamplePolicy) { return this; },
	reconcileDistributionRandom(other: ActivationSamplePolicy) { return this; },
	reconcileRandom(other: ActivationSamplePolicy) { return other; },
	reconcileStraightRandom(other: ActivationSamplePolicy) { return other; },
	reconcileAllCornerRandom(other: ActivationSamplePolicy) { return other; },
	reconcileOr(other: ActivationSamplePolicy) { return this.reconcile(other); }
});

export abstract class DistributionRandomPolicy {
	abstract distribution(upper: number, nsamples: number, rng: PRNG): number[]

	sample(regions: RegionList, nsamples: number, rng: PRNG) {
		if (regions.length == 0) {
			return [];
		}
		const range = regions.reduce((acc,r) => acc + r.end - r.start, 0);
		const rs = regions.slice().sort((a,b) => a.start - b.start);
		const randoms = this.distribution(range, nsamples, rng);
		const samples = [];
		for (let i = 0; i < nsamples; ++i) {
			let pos = randoms[i];
			for (let j = 0;; j++) {
				pos += rs[j].start;
				if (pos > rs[j].end) {
					pos -= rs[j].end;
				} else {
					samples.push(new Region(pos, rs[j].end));
					break;
				}
			}
		}
		return samples;
	}

	reconcile(other: ActivationSamplePolicy) { return other.reconcileDistributionRandom(this); }
	reconcileImmediate(_: ActivationSamplePolicy) { return this; }
	reconcileDistributionRandom(other: ActivationSamplePolicy) {
		// both conditions must hold simultaneously, so sample both and activate on the intersection of the trigger
		// windows (see BothRandomPolicy below). no joint distribution is needed for this: the trigger of the
		// conjunction is the max of the two triggers, and sampling the max of independent draws only needs the
		// marginals. what the marginals genuinely cannot capture is any dependence between the underlying conditions;
		// TODO eventually we'd like to model most of the conditions that use DistributionRandomPolicy with dynamic
		// conditions using hazard rates/a Poisson process, which would subsume this entirely (and also enable other
		// features like cooldowns for distribution-random skills).
		return new BothRandomPolicy(other, this);
	}
	// this is probably not exactly the right thing to do either, but the true random conditions do need to place a fixed trigger
	// statically ahead of time, uninfluenced by us. this means that the only alternatives are 1) this condition is coincidentally
	// fulfilled during the static random trigger or 2) the skill does not activate at all.
	// since the latter is not particularly interesting, it's safe to just ignore this sample policy and use only the true random one.
	reconcileRandom(other: ActivationSamplePolicy) { return other; }
	reconcileStraightRandom(other: ActivationSamplePolicy) { return other; }
	reconcileAllCornerRandom(other: ActivationSamplePolicy) { return other; }

	// disjunctions get different treatment than conjunctions: for an AndOperator both conditions must hold, so
	// BothRandomPolicy is correct there, but for an OrOperator either condition suffices and combining with
	// BothRandomPolicy would systematically bias triggers late. historically OrOperator reused reconcile(), which for
	// two distribution-random policies simply kept the right operand; preserve exactly that behavior (the branches of
	// an @ tend to model closely related conditions, so one branch's distribution is a reasonable stand-in for the
	// union of the branches).
	reconcileOr(other: ActivationSamplePolicy) {
		return other instanceof DistributionRandomPolicy ? other : this.reconcile(other);
	}
}

// two distribution-modeled conditions combined with an AndOperator. within the model's window semantics a
// distribution-random condition is latched from its sampled trigger position until the end of the containing region
// (DistributionRandomPolicy#sample returns Region(pos, region end)), so the conjunction is satisfied on exactly the
// intersection of the two windows: activation at the later of the two sampled triggers, or never if the windows don't
// overlap. Region#intersect returns Region(-1,-1) for disjoint windows, which RaceSolver already treats as a trigger
// that cannot activate (pos >= trigger.end is immediately true), which is the correct semantics for "the conditions
// were never simultaneously satisfied".
// NB. sampling the parents independently means the combined trigger has CDF F·G (the distribution of the max of
// independent draws); dependence between the underlying conditions is not modeled, which is the honest choice absent
// any information about it.
export class BothRandomPolicy extends DistributionRandomPolicy {
	constructor(readonly a: ActivationSamplePolicy, readonly b: ActivationSamplePolicy) { super(); }

	distribution(_0: number, _1: number, _2: PRNG): number[] {
		throw new Error('BothRandomPolicy samples its parent policies directly');
	}

	sample(regions: RegionList, nsamples: number, rng: PRNG) {
		const sa = this.a.sample(regions, nsamples, rng);
		const sb = this.b.sample(regions, nsamples, rng);
		return sa.map((ra,i) => ra.intersect(sb[i]));
	}
}

export class UniformRandomPolicy extends DistributionRandomPolicy {
	constructor() { super(); }

	distribution(upper: number, nsamples: number, rng: PRNG) {
		const nums = [];
		for (let i = 0; i < nsamples; ++i) {
			nums.push(rng.uniform(upper));
		}
		return nums;
	}
}

export class LogNormalRandomPolicy extends DistributionRandomPolicy {
	constructor(readonly mu: number, readonly sigma: number) { super(); }

	distribution(upper: number, nsamples: number, rng: PRNG) {
		// see <https://en.wikipedia.org/wiki/Box%E2%80%93Muller_transform>
		const nums = [], halfn = Math.ceil(nsamples / 2);
		for (let i = 0; i < halfn; ++i) {
			let x, y, r2;
			do {
				x = rng.random() * 2.0 - 1.0;
				y = rng.random() * 2.0 - 1.0;
				r2 = x * x + y * y;
			} while (r2 == 0.0 || r2 >= 1.0);
			const m = Math.sqrt(-2.0 * Math.log(r2) / r2) * this.sigma;
			const a = Math.exp(x * m + this.mu);
			const b = Math.exp(y * m + this.mu);
			nums.push(a,b);
		}
		// we have samples from a distribution on (0,+∞) and need activation positions on [0,upper] with the same shape. `upper` (the total
		// length of the eligible regions) isn't known when μ and σ are chosen, so instead of picking parameters that naturally cover [0,upper]
		// we rescale after the fact: map the estimated [0.1th percentile, 99.9th percentile] onto [0,upper] and clamp.
		// this is sounder than it may look:
		// - the rescale is affine, and skewness/excess kurtosis are standardized central moments, which are invariant under affine maps, so
		//   the shape is preserved exactly. the only actual distortion is the clamp, which touches 0.1% of the mass at each end.
		// - the log-normal is a scale family (c·LogNormal(μ,σ) = LogNormal(μ+ln c, σ)), so rescaling by fixed quantiles once `upper` is known
		//   is exactly equivalent to deferring the choice of μ until the scale is known, which is precisely our situation. this is also why μ
		//   drops out of the result entirely: after normalization the model genuinely has the single shape parameter σ, and that's fine.

		// inverse CDF is e^(μ + σ√2 · erf⁻¹(2p - 1))
		// constants obtained via Mathematica `InverseErf[2 * 0.999 - 1] * Sqrt[2]`
		const min = Math.exp(this.mu + this.sigma * -3.09023), max = Math.exp(this.mu + this.sigma * 3.09023);
		const range = max - min;
		return nums.map(n => Math.floor(upper * Math.min(Math.max(n - min, 0) / range, 1.0)));
	}
}

export class ErlangRandomPolicy extends DistributionRandomPolicy {
	readonly min: number
	readonly max: number

	constructor(readonly k: number, readonly lambda: number) {
		super();
		// the comment in LogNormalRandomPolicy#distribution applies here as well: rescale [0.1th percentile, 99.9th percentile] onto [0,upper].
		// Erlang is likewise a scale family (c·Erlang(k,λ) = Erlang(k,λ/c)), so λ cancels in the rescale and k is the only shape parameter.
		// there is no closed-form inverse CDF for an Erlang distribution, but for integer k the CDF itself has a closed form, so the two
		// quantiles can be computed exactly by bisection. they only depend on the (fixed) parameters, so do it once here.
		this.min = this.quantile(0.001);
		this.max = this.quantile(0.999);
	}

	// F(x) = 1 - e^(-λx) · Σ_{n=0}^{k-1} (λx)^n/n!
	cdf(x: number) {
		const lx = this.lambda * x;
		let sum = 1, term = 1;
		for (let n = 1; n < this.k; ++n) {
			term *= lx / n;
			sum += term;
		}
		return 1 - Math.exp(-lx) * sum;
	}

	quantile(p: number) {
		let lo = 0, hi = 1;
		while (this.cdf(hi) < p) {
			hi *= 2;
		}
		for (let i = 0; i < 60; ++i) {
			const mid = (lo + hi) / 2;
			if (this.cdf(mid) < p) {
				lo = mid;
			} else {
				hi = mid;
			}
		}
		return (lo + hi) / 2;
	}

	distribution(upper: number, nsamples: number, rng: PRNG) {
		const nums = [];
		for (let i = 0; i < nsamples; ++i) {
			let u = 1.0;
			for (let j = 0; j < this.k; ++j) {
				u *= rng.random();
			}
			const n = -Math.log(u) / this.lambda;
			nums.push(n);
		}
		const range = this.max - this.min;
		return nums.map(n => Math.floor(upper * Math.min(Math.max(n - this.min, 0) / range, 1.0)));
	}
}

export const StraightRandomPolicy = Object.freeze({
	sample(regions: RegionList, nsamples: number, rng: PRNG) {
		// regular RandomPolicy weights regions by their length, so any given point has an equal chance to be chosen across all regions
		// StraightRandomPolicy first picks a region with equal chance regardless of length, and then picks a random point on that region
		if (regions.length == 0) {
			return [];
		}
		const samples = [];
		for (let i = 0; i < nsamples; ++i) {
			const r = regions[rng.uniform(regions.length)];
			samples.push(r.start + rng.uniform(r.end - r.start - 10));
		}
		return samples.map(pos => new Region(pos, pos + 10));
	},
	reconcile(other: ActivationSamplePolicy) { return other.reconcileStraightRandom(this); },
	reconcileImmediate(_: ActivationSamplePolicy) { return this; },
	reconcileDistributionRandom(_: ActivationSamplePolicy) { return this; },
	reconcileRandom(_: ActivationSamplePolicy) { return this; },
	reconcileStraightRandom(other: ActivationSamplePolicy) { return other; },
	reconcileAllCornerRandom(other: ActivationSamplePolicy) { throw new Error('cannot reconcile StraightRandomPolicy with AllCornerRandomPolicy'); },
	reconcileOr(other: ActivationSamplePolicy) { return this.reconcile(other); }
});

export const AllCornerRandomPolicy = Object.freeze({
	placeTriggers(regions: RegionList, rng: PRNG) {
		const triggers = [];
		const candidates = regions.slice();
		candidates.sort((a,b) => a.start - b.start);
		while (triggers.length < 4 && candidates.length > 0) {
			const ci = rng.uniform(candidates.length);
			const c = candidates[ci];
			const start = c.start + rng.uniform(c.end - c.start - 10);
			// note that as each corner's end cannot come after the start of the next corner, this maintains that the candidates
			// are sorted by start
			if (start + 20 <= c.end) {
				candidates.splice(ci, 1, new Region(start + 10, c.end));
			} else {
				candidates.splice(ci, 1);
			}
			candidates.splice(0, ci);  // everything before this corner in the array is guaranteed to be before it in distance
			triggers.push(start);
		}
		// TODO support multiple triggers for skills with cooldown
		return new Region(triggers[0], triggers[0] + 10);  // guaranteed to be the earliest trigger since each trigger is placed after the last one
	},
	sample(regions: RegionList, nsamples: number, rng: PRNG) {
		const samples = [];
		for (let i = 0; i < nsamples; ++i) {
			samples.push(this.placeTriggers(regions, rng));
		}
		return samples;
	},
	reconcile(other: ActivationSamplePolicy) { return other.reconcileAllCornerRandom(this); },
	reconcileImmediate(_: ActivationSamplePolicy) { return this; },
	reconcileDistributionRandom(_: ActivationSamplePolicy) { return this; },
	reconcileRandom(_: ActivationSamplePolicy) { return this; },
	reconcileStraightRandom(_: ActivationSamplePolicy) { throw new Error('cannot reconcile StraightRandomPolicy with AllCornerRandomPolicy'); },
	reconcileAllCornerRandom(_: ActivationSamplePolicy) { return this; },
	reconcileOr(other: ActivationSamplePolicy) { return this.reconcile(other); }
});
