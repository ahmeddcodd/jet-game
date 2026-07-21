// enemies.js — enemy jets & helicopters with simple combat AI
import * as THREE from 'three';
import { createEnemyJet, createHelicopter } from './models.js';
import { clamp, damp, rand, randInt, pick, tmp, TAU } from './utils.js';
import {
  ENVELOPE, createFlightState, integrate, bankForTurn, pitchForClimb,
  throttleForSpeed, bankAngleOf,
} from './flight.js';

const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, 1);

// Module-level scratch. The dogfight maths runs for every enemy every frame;
// allocating vectors in there would churn the GC during the busiest moments.
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _up = new THREE.Vector3();
// Helpers get their own scratch: reusing the caller's would silently clobber
// vectors still live further down the same update().
const _h1 = new THREE.Vector3();
const _h2 = new THREE.Vector3();
const _h3 = new THREE.Vector3();

/* ---------- Dogfight tuning ------------------------------------------------
   Pulled out so the whole feel of the fight can be adjusted in one place. */
export const FIGHT = {
  sixDistance: 150,      // how far behind the player a pursuer wants to sit
  gunRange: 620,         // max range the AI will take a shot at
  gunCone: 0.965,        // dot() threshold for "I have a gun solution"
  threatCone: 0.80,      // dot() threshold for "someone is pointing at me"
  threatRange: 420,      // within this, a tailing bandit counts as a threat
  breakDuration: [1.6, 2.8],
  extendHpFrac: 0.32,    // flee below this fraction of max hp
  extendDistance: 900,   // regain this much separation before turning back
  bulletLead: 0.9,       // fraction of full lead prediction (1 = perfect aim)
};

const JET_PALETTES = [
  { body: 0x6e2222, body2: 0x4a1818, accent: 0xffaa33 },
  { body: 0x553a14, body2: 0x382608, accent: 0xffe066 },
  { body: 0x3a3550, body2: 0x251f3a, accent: 0xff5bd0 },
  { body: 0x444444, body2: 0x2a2a2a, accent: 0x66ffcc },
];
const HELO_PALETTES = [
  { body: 0x35553a, body2: 0x24392a, accent: 0xffcc44 },
  { body: 0x3a4555, body2: 0x25303a, accent: 0xff7755 },
  { body: 0x553a3a, body2: 0x3a2424, accent: 0x66ddff },
];

/* ---------- Enemy base ---------- */
class Enemy {
  constructor(mesh, type, hp, speed, score) {
    this.mesh = mesh;
    this.type = type;        // 'jet' | 'helo'
    this.hp = hp;
    this.maxHp = hp;
    this.speed = speed;
    this.score = score;
    this.alive = true;
    this.shootCooldown = rand(1.5, 3.5);
    this.hitFlash = 0;
    this.bank = 0;
    // Measured from actual position deltas rather than forward*speed, so it
    // stays correct for helicopters (which translate without pointing) and for
    // anything else that moves off its nose vector.
    this.velocity = new THREE.Vector3();
    this._prevPos = new THREE.Vector3();
    this._hasPrev = false;
    this.born = performance.now() / 1000;
    // Stores + hooks filled by the game
    this.missiles = 2;
    this.missileCooldown = rand(6, 14);
    this.flares = 6;
    this.flareCooldown = 0;
    this.onShoot = null;
    this.onMissile = null;
    this.onFlare = null;
  }

  /** Pop countermeasures when something is guiding on us. */
  tryFlares(dt, threatened) {
    this.flareCooldown -= dt;
    if (threatened && this.flares > 0 && this.flareCooldown <= 0 && this.onFlare) {
      this.flares--;
      this.flareCooldown = rand(1.5, 2.6);
      this.onFlare(this);
    }
  }
  get position() { return this.mesh.position; }

  damage(amount) {
    this.hp -= amount;
    this.hitFlash = 0.12;
    if (this.hp <= 0 && this.alive) {
      this.alive = false;
      return true; // killed
    }
    return false;
  }

  _flashUpdate() {
    if (this.hitFlash > 0) {
      this.hitFlash -= 0.016;
      const k = clamp(this.hitFlash / 0.12, 0, 1);
      this.mesh.traverse((o) => {
        if (o.isMesh && o.material && o.material.emissive) {
          o.material.emissive.setRGB(k, k * 0.1, k * 0.1);
        }
      });
    }
  }

  /** Unit forward vector of this aircraft. Written into `out`. */
  forward(out) {
    return out.set(0, 0, 1).applyQuaternion(this.mesh.quaternion);
  }

  /** Refresh measured velocity. Call at the end of each update(). */
  _trackVelocity(dt) {
    if (this._hasPrev && dt > 0) {
      this.velocity.copy(this.mesh.position).sub(this._prevPos).divideScalar(dt);
    }
    this._prevPos.copy(this.mesh.position);
    this._hasPrev = true;
  }

  /**
   * Is `other` sitting on this aircraft's tail and pointing at it?
   * Used both ways: the AI checks it to decide when to break, and the game
   * checks it against the player to raise the rear-threat warning.
   */
  isTailedBy(otherPos, otherFwd, range = FIGHT.threatRange) {
    const toMe = _h1.copy(this.mesh.position).sub(otherPos);
    const d = toMe.length();
    if (d > range || d < 1) return false;
    toMe.divideScalar(d);
    // They are behind me...
    if (this.forward(_h2).dot(toMe) < 0.30) return false;
    // ...and their nose is pointed at me.
    return otherFwd.dot(toMe) > FIGHT.threatCone;
  }
}

/* ---------- Enemy Jet: pursuit dogfighter ----------------------------------
   State machine, not a straight-line chaser:

     PURSUE  fly to the player's six o'clock rather than straight at them
     ATTACK  hold the gun solution once in cone and range
     BREAK   hard evasive turn when the PLAYER gets on THIS jet's tail
     EXTEND  run for separation when badly damaged, then come back

   The BREAK state is what makes the fight a chase in both directions: close on
   a bandit and it will try to shake you rather than obligingly fly straight.  */
/* Target speeds the AI asks for, expressed against the shared envelope rather
   than as multipliers of a per-bandit base — so "go to corner speed" means the
   same thing for every aircraft, and matches what the player's own jet does. */
const SPD = {
  scrub:  ENVELOPE.cornerSpeed * 0.72,   // ~83  slow, out-of-phase fighting
  slow:   ENVELOPE.cornerSpeed * 0.92,   // ~106 bleeding off an overtake
  corner: ENVELOPE.cornerSpeed,          // 115  best sustained turn rate
  fast:   ENVELOPE.cornerSpeed * 1.55,   // ~178 running the gap down
  run:    ENVELOPE.cornerSpeed * 1.80,   // ~207 disengaging
};

const JET_STATE = {
  PURSUE: 'pursue',      // close on the six using a lag/pure/lead curve
  ATTACK: 'attack',      // gun solution held
  BREAK: 'break',        // max-G defensive turn
  EXTEND: 'extend',      // run for separation, then re-engage
  YOYO_HI: 'yoyo_hi',    // overshooting: go vertical to kill closure
  YOYO_LO: 'yoyo_lo',    // falling behind: unload downhill for speed
  ROLL: 'barrel_roll',   // force a closing attacker out in front
  SCISSORS: 'scissors',  // reversing rolls to drag an attacker forward
};

export class EnemyJet extends Enemy {
  constructor(playerPos) {
    const palette = pick(JET_PALETTES);
    // Speed is the balance point of the whole chase. Calibrated against the
    // player (cruise ~104, max 160, afterburner ~220):
    //   pursue  x1.3  -> 124-163  faster than cruise, so ignoring them gets you killed
    //   extend  x1.45 -> 138-181  running bandits need throttle or burner to catch
    //   both well under the player's boost, so escape and pursuit stay winnable.
    super(createEnemyJet(palette), 'jet', 30, rand(95, 125), 150);
    this.palette = palette;
    this.bank = 0;
    this.state = JET_STATE.PURSUE;
    this.stateTimer = 0;
    this.stateDwell = 0;        // minimum time before this state may be abandoned

    // Flies the same model as the player (see flight.js): lift-limited G,
    // bank-then-pull steering, and speed as a consequence of thrust and drag
    // rather than a number assigned each frame.
    this.fs = createFlightState(this.speed);

    // Per-pilot traits, rolled ONCE at spawn. Everything downstream is then a
    // deterministic function of geometry — no per-frame dice — so a bandit
    // commits to a maneuver and the player can read what it is doing. The
    // variety between bandits comes from these fixed traits, not from noise.
    this.aggression = rand(0.75, 1.25);
    this.defenseStyle = Math.random();   // 0 = prefers rolling, 1 = prefers scissors
    this.breakBias = Math.random() < 0.5 ? -1 : 1;
    this.breakDir = this.breakBias;

    this._spawn(playerPos);
  }

  _spawn(playerPos) {
    // Spawn in front arc, far away
    const a = rand(-0.8, 0.8);
    const dist = rand(900, 1500);
    const fwdFlat = tmp.v2.set(Math.sin(a), 0, Math.cos(a));
    this.mesh.position.copy(playerPos).addScaledVector(fwdFlat, dist);
    this.mesh.position.y = clamp(playerPos.y + rand(-120, 200), 60, 600);
  }

  _enter(state, duration = 0, dwell = 0) {
    if (this.state !== state) this.stateDwell = dwell;
    this.state = state;
    this.stateTimer = duration;
  }

  /**
   * Which way to roll out of trouble.
   *
   * Continue the roll already in progress, so a defensive move flows out of
   * the aircraft's current attitude instead of snapping to a coin flip; only
   * near wings-level does the pilot's fixed bias decide. Deterministic, and it
   * reads as one continuous maneuver rather than a twitch.
   */
  _rollOutDir() {
    const bank = bankAngleOf(this.mesh.quaternion);
    if (Math.abs(bank) > 0.20) return Math.sign(bank);
    return this.breakBias;
  }

  update(dt, t, player) {
    if (!this.alive) return;

    const toPlayer = _a.copy(player.position).sub(this.mesh.position);
    const dist = toPlayer.length();
    const dirToPlayer = _b.copy(toPlayer).divideScalar(Math.max(dist, 0.001));
    const myFwd = this.forward(_d);

    const playerFwd = tmp.v3.set(0, 0, 1).applyQuaternion(player.mesh.quaternion);
    const hunted = this.isTailedBy(player.position, playerFwd, 340);
    this.stateTimer -= dt;

    // Closure rate: positive means we're gaining on them. Drives the yo-yos,
    // which exist purely to manage closure without giving up the tail position.
    const closure = (this._prevDist !== undefined && dt > 0)
      ? (this._prevDist - dist) / dt : 0;
    this._prevDist = dist;

    // ---- Transitions ---------------------------------------------------
    // Every decision below is a function of the engagement geometry — range,
    // closure, aspect, energy — plus this pilot's fixed traits. Nothing is
    // re-rolled per frame, and `stateDwell` stops a bandit abandoning a
    // maneuver the instant the geometry wobbles. Together that is the
    // difference between a chase you can read and one that looks like noise.
    this.stateDwell -= dt;
    const committed = this.stateDwell > 0;
    const transient = this.state === JET_STATE.YOYO_HI || this.state === JET_STATE.YOYO_LO
      || this.state === JET_STATE.ROLL || this.state === JET_STATE.SCISSORS;

    if (this.hp <= this.maxHp * FIGHT.extendHpFrac && this.state !== JET_STATE.EXTEND) {
      this._enter(JET_STATE.EXTEND, 0, 1.5);
      this.breakDir = this._rollOutDir();
    } else if (this.state === JET_STATE.EXTEND) {
      // Run until we have room, then turn back into the fight.
      if (dist > FIGHT.extendDistance) this._enter(JET_STATE.PURSUE, 0, 1.0);
    } else if (hunted && !transient && !committed) {
      this._goDefensive(dist, closure);
    } else if (transient || this.state === JET_STATE.BREAK) {
      // Re-evaluate when the current move expires. Always re-entering BREAK
      // here meant a bandit that got jumped would break, and break, and break —
      // the roll and scissors defences became unreachable once a fight started.
      if (this.stateTimer <= 0 && !hunted) this._enter(JET_STATE.PURSUE, 0, 0.8);
      else if (this.stateTimer <= 0) this._goDefensive(dist, closure);
    } else if (!committed) {
      // Hysteresis on the gun-solution test. A single threshold sat right on
      // the boundary and flipped PURSUE/ATTACK about three times a second —
      // 93 changes in 30 seconds — which kept yanking the aim point between
      // the target's six and a lead point.
      const aim = myFwd.dot(dirToPlayer);
      const onTarget = this.state === JET_STATE.ATTACK ? aim > 0.85 : aim > 0.93;
      // Offensive closure management — the yo-yos.
      if (dist < 260 && closure > 55) {
        // Overshooting: pull up out of plane to bleed closure, then drop back in.
        this._enter(JET_STATE.YOYO_HI, 1.1, 0.9);
      } else if (dist > 520 && closure < 12 && this.mesh.position.y > player.position.y + 90) {
        // Falling behind with altitude in hand: trade it for speed.
        this._enter(JET_STATE.YOYO_LO, 1.1, 0.9);
      } else {
        // Short dwell here too, so even a legitimate PURSUE/ATTACK swap has to
        // hold for a moment rather than toggling on frame-to-frame noise.
        this._enter(onTarget && dist < FIGHT.gunRange
          ? JET_STATE.ATTACK : JET_STATE.PURSUE, 0, 0.5);
      }
    }

    // ---- Steering per state -------------------------------------------
    const desired = _c;
    let targetSpeed = SPD.corner;

    switch (this.state) {
      case JET_STATE.BREAK: {
        // Break turn: haul off perpendicular to the attacker and change plane.
        const away = desired.copy(this.mesh.position).sub(player.position).normalize();
        const side = _up.crossVectors(away, UP).normalize().multiplyScalar(this.breakDir);
        desired.add(side.multiplyScalar(1.4)).normalize();
        desired.y += 0.35 * this.breakDir;
        desired.normalize();
        targetSpeed = SPD.corner;      // corner speed = best turn rate
        break;
      }
      case JET_STATE.EXTEND: {
        desired.copy(this.mesh.position).sub(player.position).normalize();
        desired.y += 0.12;
        desired.normalize();
        targetSpeed = SPD.run;         // separate, then re-engage
        break;
      }
      case JET_STATE.YOYO_HI: {
        // High yo-yo: climb out of the turn plane. Trades speed for position
        // and kills closure without ever leaving the target's rear quarter.
        desired.copy(dirToPlayer);
        desired.y += 0.85;
        desired.normalize();
        targetSpeed = SPD.slow;        // trading speed for position
        break;
      }
      case JET_STATE.YOYO_LO: {
        // Low yo-yo: unload downhill, convert altitude into the speed needed
        // to close the gap, then pull back up into the fight.
        desired.copy(dirToPlayer);
        desired.y -= 0.75;
        desired.normalize();
        targetSpeed = SPD.fast;        // altitude converted into closure
        break;
      }
      case JET_STATE.ROLL: {
        // Barrel roll defence: corkscrew around the flight path so a fast
        // attacker slides out in front instead of tracking.
        const away = desired.copy(this.mesh.position).sub(player.position).normalize();
        const side = _up.crossVectors(away, UP).normalize();
        const phase = this.stateTimer * 5.2;
        desired.addScaledVector(side, Math.cos(phase) * 1.5);
        desired.y += Math.sin(phase) * 1.2;
        desired.normalize();
        targetSpeed = SPD.scrub;       // scrubbing speed is the entire point
        break;
      }
      case JET_STATE.SCISSORS: {
        // Flat scissors: repeated reversals to stay slow and out of phase,
        // trying to make the attacker fly through and swap roles.
        this.scissorPhase = (this.scissorPhase || 0) + dt;
        if (this.scissorPhase > 0.85) { this.scissorPhase = 0; this.breakDir *= -1; }
        const side = _up.crossVectors(dirToPlayer, UP).normalize();
        desired.copy(dirToPlayer).addScaledVector(side, this.breakDir * 2.1).normalize();
        targetSpeed = SPD.scrub;       // slow, out-of-phase fight
        break;
      }
      case JET_STATE.ATTACK: {
        // Lead the target so the shot has somewhere to arrive.
        desired.copy(this._leadPoint(player, dist)).sub(this.mesh.position).normalize();
        targetSpeed = this._closureSpeed(dist, player);
        break;
      }
      default: {
        // PURSUE with the appropriate curve:
        //   lag   — aim behind them; preserves energy and prevents an overshoot
        //   pure  — straight at them; the default closing curve
        //   lead  — aim ahead; only once close enough for it to become a shot
        const six = desired.copy(player.position)
          .addScaledVector(playerFwd, -FIGHT.sixDistance);
        if (dist > 700) {
          six.lerp(player.position, 0.55);           // cut the corner from far out
        } else if (closure > 70 && dist < 340) {
          // Closing too fast: lag behind their tail to bleed off the overtake.
          six.addScaledVector(playerFwd, -110);
        } else if (dist < 300) {
          six.copy(this._leadPoint(player, dist));   // transition to a firing solution
        }
        desired.sub(this.mesh.position).normalize();
        targetSpeed = this._closureSpeed(dist, player);
        if (closure > 70 && dist < 340) targetSpeed = SPD.slow;   // kill an overtake
        break;
      }
    }

    // Altitude band — keep the fight visible and off the deck.
    if (this.mesh.position.y < 90) desired.y = Math.max(desired.y, 0.32);
    if (this.mesh.position.y > 640) desired.y = Math.min(desired.y, -0.32);
    desired.normalize();

    // ---- Fly it ---------------------------------------------------------
    // Exactly the player's model: bank toward where you want to go, pull, and
    // let speed be the outcome of thrust, gravity along the flight path and
    // drag. The AI never sets its speed or heading directly — it works the same
    // controls, inside the same envelope, so a bandit cannot out-turn physics
    // and the player's feel for their own jet predicts what the enemy can do.
    const bankGain = (this.state === JET_STATE.BREAK ? 3.4 : 2.6) * this.aggression;
    const fwdY = this.forward(_d).y;
    integrate(this.mesh, this.fs, {
      bank:  bankForTurn(this.mesh.quaternion, desired, ENVELOPE, bankGain),
      pitch: pitchForClimb(this.mesh.quaternion, desired),
      throttle: throttleForSpeed(this.fs, targetSpeed, fwdY),
      // Burner only when genuinely trying to run the gap down or open it.
      boost: targetSpeed >= SPD.fast && this.fs.speed < targetSpeed - 15,
    }, dt);
    this.speed = this.fs.speed;
    this.bank = bankAngleOf(this.mesh.quaternion);
    this.mesh.position.addScaledVector(this.forward(_d), this.speed * dt);

    // ---- Guns ---------------------------------------------------------
    this.shootCooldown -= dt;
    if (this.shootCooldown <= 0 && this.onShoot &&
        dist < FIGHT.gunRange && this.state !== JET_STATE.EXTEND) {
      const aimDot = this.forward(_d).dot(dirToPlayer);
      if (aimDot > FIGHT.gunCone) {
        this.onShoot(this, player);
        this.shootCooldown = rand(1.4, 2.4) / this.aggression;
      } else {
        this.shootCooldown = 0.2; // recheck soon
      }
    }

    // ---- Missiles -----------------------------------------------------
    // Longer reach than guns and needs a cleaner aspect, so they open with a
    // missile shot on the approach and settle into guns once in close.
    this.missileCooldown -= dt;
    if (this.missileCooldown <= 0 && this.onMissile && this.missiles > 0 &&
        dist > 260 && dist < 1400 && this.state !== JET_STATE.EXTEND &&
        this.forward(_d).dot(dirToPlayer) > 0.93) {
      this.onMissile(this);
      this.missiles--;
      this.missileCooldown = rand(8, 14);
    }

    this._trackVelocity(dt);
    this._flashUpdate();
  }

  /**
   * Pick a defensive move from the engagement geometry.
   *
   * A fast attacker close aboard is beaten by forcing an overshoot; one
   * grinding around at matched speed is beaten by scissoring; otherwise break.
   * `defenseStyle` is fixed per pilot and only breaks ties inside the overlap
   * band, so the same situation always draws the same response from the same
   * bandit — variety between pilots, consistency within one.
   */
  _goDefensive(dist, closure) {
    // closure > 0 means the gap is shrinking, i.e. they are running us down.
    const attackerClosing = closure > 30;
    if (dist < 170 && attackerClosing && this.defenseStyle < 0.65) {
      this._enter(JET_STATE.ROLL, 1.6, 1.4);
    } else if (dist < 230 && !attackerClosing && this.defenseStyle > 0.45) {
      this._enter(JET_STATE.SCISSORS, 2.8, 2.0);
      this.scissorPhase = 0;
    } else {
      this._enter(JET_STATE.BREAK, 2.2, 1.6);
    }
    this.breakDir = this._rollOutDir();
  }

  /**
   * Speed to ask for in order to close on the target's six.
   *
   * Match the target's speed, plus a term proportional to how much range there
   * is left to take out. Continuous, so there is no threshold for the bandit to
   * settle against — discrete speed bands produced a stable equilibrium exactly
   * at the band edge and the chase stalled there. It also self-limits: at the
   * desired range the closure term is zero and the bandit simply formates on
   * the target's tail, and inside it the term goes negative so it backs off
   * instead of overrunning into a merge.
   */
  _closureSpeed(dist, player) {
    const want = FIGHT.sixDistance;
    const match = player.speed || SPD.corner;
    return clamp(match + (dist - want) * 0.45, SPD.scrub, SPD.run);
  }

  /** Where the player will be when the bullet arrives. */
  _leadPoint(player, dist) {
    const bulletSpeed = 520;
    const lead = Math.min(dist / bulletSpeed, 1.4) * FIGHT.bulletLead;
    const vel = player.velocity || _h3.set(0, 0, 0);
    return _h2.copy(player.position).addScaledVector(vel, lead);
  }
}

/* ---------- Helicopter: hover + strafe gunship ---------- */
export class EnemyHelo extends Enemy {
  constructor(playerPos) {
    const palette = pick(HELO_PALETTES);
    super(createHelicopter(palette), 'helo', 45, rand(28, 42), 200);
    this.palette = palette;
    this.preferredRange = rand(120, 260);
    this._spawn(playerPos);
    this.rotorSpin = 0;
    this.jinkTimer = 0;
    this.jinkDir = pick([-1, 1]);
    this.strafeDir = pick([-1, 1]);
    this.strafeTimer = rand(2.5, 4.5);
  }
  _spawn(playerPos) {
    const a = rand(0, TAU);
    const dist = rand(700, 1100);
    this.mesh.position.set(
      playerPos.x + Math.cos(a) * dist,
      clamp(playerPos.y + rand(-60, 120), 70, 350),
      playerPos.z + Math.sin(a) * dist,
    );
  }

  update(dt, t, player) {
    if (!this.alive) return;
    const toPlayer = tmp.v1.copy(player.position).sub(this.mesh.position);
    const dist = toPlayer.length();
    const dir = toPlayer.clone().normalize();

    // Maintain preferred range: approach if far, back off if close
    // Strafe direction is held and only reversed on a timer. It used to be
    // re-picked with pick([-1,1]) EVERY FRAME, so at 60fps the gunship was
    // being told to strafe left and right ~30 times a second — it vibrated in
    // place instead of translating. This is the single worst source of
    // "enemies move randomly" in the whole game.
    this.strafeTimer -= dt;
    if (this.strafeTimer <= 0) {
      this.strafeDir *= -1;
      this.strafeTimer = rand(2.5, 4.5);
    }
    let moveDir;
    if (dist > this.preferredRange + 40) moveDir = dir.clone();
    else if (dist < this.preferredRange - 40) moveDir = dir.clone().negate();
    else moveDir = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(this.strafeDir);

    // Bob up & down
    moveDir.y = Math.sin(t * 1.2 + this.born) * 0.4;

    // Jink when the player lines up on them. A gunship can't outrun a jet, so
    // it breaks sideways and drops instead — enough to spoil a lazy gun pass
    // without making them impossible to kill.
    const playerFwd = tmp.v3.set(0, 0, 1).applyQuaternion(player.mesh.quaternion);
    if (this.isTailedBy(player.position, playerFwd, 300)) {
      this.jinkTimer -= dt;
      if (this.jinkTimer <= 0) {
        this.jinkDir = -this.jinkDir;
        this.jinkTimer = rand(0.7, 1.3);
      }
      const side = _h1.set(-dir.z, 0, dir.x).multiplyScalar(this.jinkDir * 1.8);
      moveDir.add(side);
      moveDir.y -= 0.5;
    }

    // Helicopter faces the player (yaw only) regardless of move direction
    const yawDir = new THREE.Vector3(dir.x, 0, dir.z).normalize();
    const desiredQ = tmp.q1.setFromUnitVectors(FWD, yawDir);
    this.mesh.quaternion.slerp(desiredQ, 1 - Math.exp(-3 * dt));

    // Translate (helicopter can move without pointing)
    this.mesh.position.addScaledVector(moveDir, this.speed * dt);

    // Spin main rotor & tail rotor
    this.rotorSpin += dt * 28;
    if (this.mesh.userData.rotor) this.mesh.userData.rotor.rotation.y = this.rotorSpin;
    if (this.mesh.userData.tailRotor) this.mesh.userData.tailRotor.rotation.x = this.rotorSpin * 1.6;

    // Shoot
    this.shootCooldown -= dt;
    if (this.shootCooldown <= 0 && dist < 500 && this.onShoot) {
      this.onShoot(this, player);
      this.shootCooldown = rand(1.8, 3.2);
    }

    this._trackVelocity(dt);
    this._flashUpdate();
  }
}

/* ---------- Bullet (tracer) for both player & enemy ---------- */
export class Bullet {
  constructor(scene, origin, dir, speed, owner, damage, color = 0xfff0a0) {
    this.position = origin.clone();
    this.dir = dir.clone().normalize();
    this.speed = speed;
    this.owner = owner;        // 'player' | 'enemy'
    this.damage = damage;
    this.life = 2.0;
    this.alive = true;

    const geo = new THREE.CylinderGeometry(0.12, 0.12, 2.4, 5);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.copy(origin);
    // Orient along dir
    this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.dir);
    scene.add(this.mesh);
  }
  update(dt) {
    this.position.addScaledVector(this.dir, this.speed * dt);
    this.mesh.position.copy(this.position);
    this.life -= dt;
    if (this.life <= 0) {
      this.alive = false;
    }
  }
  destroy(scene) {
    scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

/* ---------- Missile: proportional navigation ------------------------------
   Real air-to-air guidance, not a lerp toward the target's current position.

   Proportional navigation turns the missile at N times the rotation rate of
   the line of sight to the target. The consequence — and the reason it is what
   actual missiles use — is that if the LOS stops rotating, you are on a
   collision course, so the missile automatically flies a lead intercept
   instead of chasing the target's tail.

   The counters fall out of the same maths rather than being special-cased:
    - a hard break spikes the LOS rate, and the missile's finite turn rate
      means it can be out-turned at close range;
    - the seeker has a finite FOV, so a big enough aspect change breaks lock
      and the missile goes ballistic;
    - flares present a competing heat source inside the seeker cone.        */
export const MISSILE = {
  N: 4.0,               // navigation constant — 3-5 is the realistic band
  boostThrust: 340,     // motor accel while burning
  boostTime: 1.4,       // seconds of motor burn
  dragCoef: 0.0016,     // coast deceleration ∝ v²
  launchSpeed: 130,
  maxTurn: 3.4,         // rad/s — finite, so it can be defeated
  seekerFOV: 0.35,      // dot() limit; outside this the seeker loses the target
  proximity: 9,         // proximity fuze radius
  life: 7.0,
  flareRadius: 220,     // flares within this of the missile can spoof it
  flareChance: 0.55,    // per decoy evaluation
};

export class Missile {
  constructor(scene, origin, target, owner = 'player') {
    this.position = origin.clone();
    this.target = target;          // Enemy/Player or null
    this.owner = owner;
    this.speed = MISSILE.launchSpeed;
    this.life = MISSILE.life;
    this.alive = true;
    this.detonated = false;
    this.damage = 55;
    this.dir = new THREE.Vector3(0, 0, 1);
    this.motorTime = MISSILE.boostTime;
    this.hasLock = !!target;

    this._losPrev = new THREE.Vector3();
    this._hasLos = false;

    const { mesh, trail } = makeMissileMesh();
    this.mesh = mesh;
    this.mesh.position.copy(origin);
    this.trail = trail;
    this.trail.mesh.position.copy(origin);
    scene.add(this.mesh, this.trail.mesh);
    this.scene = scene;
  }

  /** Target position, or null if the seeker has nothing. */
  get _aimPoint() {
    if (this.decoy) return this.decoy.alive ? this.decoy.position : null;
    return (this.target && this.target.alive) ? this.target.position : null;
  }

  /** Offer a set of flares to the seeker; may re-target onto one. */
  considerFlares(flares) {
    if (!this.hasLock || this.decoy) return;
    for (const f of flares) {
      if (!f.alive || f.owner === this.owner) continue;
      const d = f.position.distanceTo(this.position);
      if (d > MISSILE.flareRadius) continue;
      // Only decoyed if the flare is inside the seeker's field of view.
      const toFlare = _h1.copy(f.position).sub(this.position).divideScalar(Math.max(d, 0.001));
      if (this.dir.dot(toFlare) < 1 - MISSILE.seekerFOV) continue;
      if (Math.random() < MISSILE.flareChance) {
        this.decoy = f;
        this.hasLock = false;
        return;
      }
    }
  }

  update(dt) {
    this.life -= dt;
    if (this.life <= 0) { this.alive = false; return; }

    // ---- Propulsion: burn hard, then coast and decay ----
    if (this.motorTime > 0) {
      this.motorTime -= dt;
      this.speed += MISSILE.boostThrust * dt;
    } else {
      this.speed = Math.max(60, this.speed - MISSILE.dragCoef * this.speed * this.speed * dt);
    }

    // ---- Guidance ----
    const aim = this._aimPoint;
    if (aim) {
      const los = _h1.copy(aim).sub(this.position);
      const dist = los.length();
      if (dist > 0.001) {
        los.divideScalar(dist);

        // Seeker gimbal limit: too far off the nose and it loses the target.
        if (this.dir.dot(los) < 1 - MISSILE.seekerFOV) {
          this.hasLock = false;
          this.target = null;
          this.decoy = null;
        } else if (this._hasLos) {
          // omega = losPrev x los  — magnitude ≈ the LOS rotation this frame.
          const axis = _h2.crossVectors(this._losPrev, los);
          const sin = Math.min(axis.length(), 1);
          if (sin > 1e-6) {
            axis.divideScalar(sin);
            const losRate = Math.asin(sin) / dt;
            // Turn at N x the LOS rate, capped by airframe limits.
            const cmd = Math.min(MISSILE.N * losRate, MISSILE.maxTurn) * dt;
            this.dir.applyAxisAngle(axis, cmd).normalize();
          }
        }
        this._losPrev.copy(los);
        this._hasLos = true;

        // Proximity fuze — flagged for the game loop to resolve damage.
        if (dist < MISSILE.proximity) {
          this.detonated = true;
          this.alive = false;
          return;
        }
      }
    }

    this.position.addScaledVector(this.dir, this.speed * dt);
    this.mesh.position.copy(this.position);
    this.mesh.quaternion.setFromUnitVectors(FWD, this.dir);

    this.trail.update(dt, this.position, this.dir);
  }

  destroy() {
    this.scene.remove(this.mesh, this.trail.mesh);
    this.mesh.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
    this.trail.destroy(this.scene);
  }
}

/* ---------- Flare countermeasure ---------- */
export class Flare {
  constructor(scene, origin, velocity, owner) {
    this.position = origin.clone();
    this.velocity = velocity.clone();
    this.owner = owner;
    this.life = 3.2;
    this.alive = true;

    const geo = new THREE.SphereGeometry(0.9, 6, 5);
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffd08a, transparent: true, opacity: 1, blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.position.copy(origin);
    scene.add(this.mesh);
    this.scene = scene;
  }
  update(dt) {
    this.life -= dt;
    if (this.life <= 0) { this.alive = false; return; }
    this.velocity.y -= 26 * dt;              // fall away behind the aircraft
    this.velocity.multiplyScalar(1 - 0.9 * dt);
    this.position.addScaledVector(this.velocity, dt);
    this.mesh.position.copy(this.position);
    const k = Math.max(0, this.life / 3.2);
    this.mesh.material.opacity = k;
    this.mesh.scale.setScalar(0.6 + (1 - k) * 2.2);
  }
  destroy() {
    this.scene.remove(this.mesh);
    this.mesh.geometry.dispose();
    this.mesh.material.dispose();
  }
}

// Missile visual + ribbon trail
function makeMissileMesh() {
  const g = new THREE.Group();
  const matBody = new THREE.MeshStandardMaterial({ color: 0xd8dde2, flatShading: true, metalness: 0.4, roughness: 0.4 });
  const bodyGeo = new THREE.CylinderGeometry(0.18, 0.18, 1.6, 6);
  bodyGeo.rotateX(Math.PI / 2);
  g.add(new THREE.Mesh(bodyGeo, matBody));
  const tipGeo = new THREE.ConeGeometry(0.18, 0.5, 6);
  tipGeo.rotateX(-Math.PI / 2);
  const tip = new THREE.Mesh(tipGeo, new THREE.MeshStandardMaterial({ color: 0xff4444, flatShading: true }));
  tip.position.z = 1.0;
  g.add(tip);
  const finGeo = new THREE.BoxGeometry(0.9, 0.02, 0.34);
  const f1 = new THREE.Mesh(finGeo, new THREE.MeshStandardMaterial({ color: 0x8a9098, flatShading: true }));
  f1.position.z = -0.7; g.add(f1);
  const f2 = f1.clone(); f2.rotation.z = Math.PI / 2; g.add(f2);
  // Glow
  const glow = new THREE.Mesh(
    new THREE.CircleGeometry(0.16, 8),
    new THREE.MeshBasicMaterial({ color: 0xffcc66 })
  );
  glow.position.z = -0.9; glow.rotation.y = Math.PI;
  g.add(glow);

  const trail = new Trail(0xffaa44, 26);
  return { mesh: g, trail };
}

/* ---------- Simple ring-buffer ribbon trail ---------- */
export class Trail {
  constructor(color, segments = 20) {
    this.segments = segments;
    this.points = [];
    const positions = new Float32Array(segments * 2 * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.6, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this._geo = geo;
    this._color = new THREE.Color(color);
  }
  update(dt, pos, dir) {
    this.points.unshift(pos.clone());
    if (this.points.length > this.segments) this.points.pop();
    const arr = this._geo.attributes.position.array;
    const up = new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(dir, up).normalize().multiplyScalar(0.7);
    const n = this.points.length;
    for (let i = 0; i < n; i++) {
      const p = this.points[i];
      const w = (1 - i / this.segments) * 0.8;
      arr[i * 6 + 0] = p.x + right.x * w;
      arr[i * 6 + 1] = p.y + right.y * w;
      arr[i * 6 + 2] = p.z + right.z * w;
      arr[i * 6 + 3] = p.x - right.x * w;
      arr[i * 6 + 4] = p.y - right.y * w;
      arr[i * 6 + 5] = p.z - right.z * w;
    }
    this._geo.attributes.position.needsUpdate = true;
    this._geo.setDrawRange(0, n * 2);
  }
  destroy(scene) {
    scene.remove(this.mesh);
    this._geo.dispose();
    this.mesh.material.dispose();
  }
}
