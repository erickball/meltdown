/**
 * State History Manager
 *
 * Stores simulation states for "back up one step" functionality.
 *
 * Storage strategy:
 * - Keep the last 100 steps (fine-grained recent history)
 * - Keep one snapshot per full second of sim time (coarse long-term history)
 * - Maximum 1000 total snapshots
 * - When over limit, thin out old snapshots intelligently
 */

import { SimulationState } from '../simulation/types';
import { cloneSimulationState } from '../simulation/solver';

interface StateSnapshot {
  state: SimulationState;
  simTime: number;           // Simulation time in seconds
  wallTime: number;          // Wall clock time when captured (performance.now())
  stepNumber: number;        // Total step count when captured
  isSecondMarker: boolean;   // True if this is a per-second snapshot
}

export class StateHistory {
  private snapshots: StateSnapshot[] = [];
  private readonly maxRecentSteps = 100;
  private readonly maxTotalSnapshots = 1000;

  // Track which full seconds we have snapshots for
  private secondMarkers = new Set<number>();

  // Last recorded step to avoid duplicates
  private lastRecordedStep = -1;

  // Current position in history (for forward/back navigation without deletion)
  // -1 means we're at the end (most recent state)
  private currentIndex = -1;

  /**
   * Record a state snapshot after a successful simulation step.
   *
   * @param state - The simulation state to snapshot
   * @param stepNumber - Total steps taken so far
   */
  recordStep(state: SimulationState, stepNumber: number): void {
    // Avoid duplicate recordings
    if (stepNumber === this.lastRecordedStep) {
      return;
    }

    // If we've navigated back and are now taking a new step,
    // discard all future states (we're branching off)
    if (this.currentIndex >= 0 && this.currentIndex < this.snapshots.length - 1) {
      const removed = this.snapshots.splice(this.currentIndex + 1);
      // Update second markers for removed snapshots
      for (const s of removed) {
        if (s.isSecondMarker) {
          const second = Math.floor(s.simTime);
          const stillHasSecond = this.snapshots.some(
            snap => Math.floor(snap.simTime) === second
          );
          if (!stillHasSecond) {
            this.secondMarkers.delete(second);
          }
        }
      }
    }

    // Reset to end position
    this.currentIndex = -1;
    this.lastRecordedStep = stepNumber;

    const simTime = state.time;
    const currentSecond = Math.floor(simTime);

    // Determine if this should be a second marker
    const isSecondMarker = !this.secondMarkers.has(currentSecond);

    // Clone the state
    const snapshot: StateSnapshot = {
      state: cloneSimulationState(state),
      simTime,
      wallTime: performance.now(),
      stepNumber,
      isSecondMarker,
    };

    this.snapshots.push(snapshot);

    if (isSecondMarker) {
      this.secondMarkers.add(currentSecond);
    }

    // Enforce limits
    this.enforceLimit();
  }

  /**
   * Navigate back one step in history.
   * Does NOT delete future states - they remain available for forward navigation.
   * Returns the snapshot to restore to, or null if already at the beginning.
   */
  navigateBack(): StateSnapshot | null {
    if (this.snapshots.length === 0) {
      return null;
    }

    // Determine current effective position
    const effectiveIndex = this.currentIndex >= 0
      ? this.currentIndex
      : this.snapshots.length - 1;

    // Can't go back past the first snapshot
    if (effectiveIndex <= 0) {
      return null;
    }

    // Move back one position
    this.currentIndex = effectiveIndex - 1;
    return this.snapshots[this.currentIndex];
  }

  /**
   * Navigate forward one step in history.
   * Returns the snapshot to restore to, or null if already at the end.
   */
  navigateForward(): StateSnapshot | null {
    if (this.snapshots.length === 0 || this.currentIndex < 0) {
      return null; // Already at end
    }

    if (this.currentIndex >= this.snapshots.length - 1) {
      return null; // Already at end
    }

    this.currentIndex++;

    // If we've reached the end, reset to -1
    if (this.currentIndex >= this.snapshots.length - 1) {
      this.currentIndex = -1;
    }

    return this.snapshots[this.currentIndex >= 0 ? this.currentIndex : this.snapshots.length - 1];
  }

  /**
   * Navigate to a specific snapshot by index.
   * Returns the snapshot, or null if index is invalid.
   */
  navigateToIndex(index: number): StateSnapshot | null {
    if (index < 0 || index >= this.snapshots.length) {
      return null;
    }

    this.currentIndex = index === this.snapshots.length - 1 ? -1 : index;
    return this.snapshots[index];
  }

  /**
   * Find the snapshot closest to a given simulation time.
   * Returns null if no snapshots exist.
   */
  findClosestToTime(targetTime: number): StateSnapshot | null {
    if (this.snapshots.length === 0) {
      return null;
    }

    let closest = this.snapshots[0];
    let closestDiff = Math.abs(closest.simTime - targetTime);

    for (const snapshot of this.snapshots) {
      const diff = Math.abs(snapshot.simTime - targetTime);
      if (diff < closestDiff) {
        closest = snapshot;
        closestDiff = diff;
      }
    }

    return closest;
  }

  /**
   * Navigate to a specific snapshot (by time).
   * Does NOT remove future snapshots - they remain available.
   * Returns the snapshot state, or null if not found.
   */
  restoreToTime(targetTime: number): SimulationState | null {
    const snapshot = this.findClosestToTime(targetTime);
    if (!snapshot) {
      return null;
    }

    const targetIndex = this.snapshots.indexOf(snapshot);
    this.currentIndex = targetIndex === this.snapshots.length - 1 ? -1 : targetIndex;

    return cloneSimulationState(snapshot.state);
  }

  /**
   * Get available snapshot count, time range, and current position.
   */
  getInfo(): {
    count: number;
    oldestTime: number;
    newestTime: number;
    currentIndex: number;  // -1 means at end
    currentTime: number;
    currentStepNumber: number;
  } {
    if (this.snapshots.length === 0) {
      return { count: 0, oldestTime: 0, newestTime: 0, currentIndex: -1, currentTime: 0, currentStepNumber: 0 };
    }

    const effectiveIndex = this.currentIndex >= 0
      ? this.currentIndex
      : this.snapshots.length - 1;

    return {
      count: this.snapshots.length,
      oldestTime: this.snapshots[0].simTime,
      newestTime: this.snapshots[this.snapshots.length - 1].simTime,
      currentIndex: this.currentIndex,
      currentTime: this.snapshots[effectiveIndex].simTime,
      currentStepNumber: this.snapshots[effectiveIndex].stepNumber,
    };
  }

  /**
   * Get a list of all snapshots for UI display.
   * Returns lightweight info (not the full state).
   */
  getSnapshotList(): Array<{ index: number; simTime: number; stepNumber: number; isSecondMarker: boolean }> {
    return this.snapshots.map((s, index) => ({
      index,
      simTime: s.simTime,
      stepNumber: s.stepNumber,
      isSecondMarker: s.isSecondMarker,
    }));
  }

  /**
   * Clear all history (call on simulation reset).
   */
  clear(): void {
    this.snapshots = [];
    this.secondMarkers.clear();
    this.lastRecordedStep = -1;
    this.currentIndex = -1;
  }

  /**
   * Enforce the maximum snapshot limit using progressive thinning.
   *
   * Strategy:
   * 1. Always keep the most recent maxRecentSteps snapshots (fine-grained)
   * 2. For older snapshots, keep one per N seconds where N increases with age:
   *    - 0-100s from current time: keep every 1 second
   *    - 100-1000s ago: keep every 2 seconds
   *    - 1000-10000s ago: keep every 10 seconds
   *    - 10000s+ ago: keep every 60 seconds
   * 3. Non-marker snapshots are removed first, then markers that don't meet
   *    the spacing requirement for their age.
   */
  private enforceLimit(): void {
    if (this.snapshots.length <= this.maxTotalSnapshots) {
      return;
    }

    // How many we need to remove
    const excess = this.snapshots.length - this.maxTotalSnapshots;

    // Identify the "old" region (everything before the recent 100)
    const recentStart = Math.max(0, this.snapshots.length - this.maxRecentSteps);

    // Get current simulation time (newest snapshot)
    const currentTime = this.snapshots.length > 0
      ? this.snapshots[this.snapshots.length - 1].simTime
      : 0;

    // Determine required spacing based on age (time before current)
    const getRequiredSpacing = (simTime: number): number => {
      const age = currentTime - simTime;
      if (age < 100) return 1;       // Every second for recent history
      if (age < 1000) return 2;      // Every 2 seconds for 100-1000s ago
      if (age < 10000) return 10;    // Every 10 seconds for 1000-10000s ago
      return 60;                      // Every minute for very old history
    };

    // First pass: remove all non-markers in old region
    const toRemove = new Set<number>();
    for (let i = 0; i < recentStart && toRemove.size < excess; i++) {
      if (!this.snapshots[i].isSecondMarker) {
        toRemove.add(i);
      }
    }

    // Second pass: thin markers that don't meet spacing requirements
    if (toRemove.size < excess) {
      // Group remaining markers by their required spacing bucket
      // and keep only one per spacing interval
      const keptMarkerTimes = new Map<number, number>(); // spacing -> last kept time

      for (let i = 0; i < recentStart && toRemove.size < excess; i++) {
        if (toRemove.has(i)) continue;

        const snapshot = this.snapshots[i];
        const spacing = getRequiredSpacing(snapshot.simTime);

        // Calculate which interval this snapshot belongs to
        const intervalStart = Math.floor(snapshot.simTime / spacing) * spacing;

        // Check if we already have a snapshot for this interval
        const key = intervalStart * 1000 + spacing; // unique key per interval+spacing
        if (keptMarkerTimes.has(key)) {
          // We already kept one for this interval, remove this one
          toRemove.add(i);
        } else {
          // Keep this one (first snapshot in this interval)
          keptMarkerTimes.set(key, snapshot.simTime);
        }
      }
    }

    // Perform the removal (in reverse order to preserve indices)
    const indicesToRemove = Array.from(toRemove).sort((a, b) => b - a);
    for (const idx of indicesToRemove) {
      const removed = this.snapshots.splice(idx, 1)[0];
      if (removed.isSecondMarker) {
        const second = Math.floor(removed.simTime);
        const stillHasSecond = this.snapshots.some(
          s => Math.floor(s.simTime) === second
        );
        if (!stillHasSecond) {
          this.secondMarkers.delete(second);
        }
      }
    }
  }
}
