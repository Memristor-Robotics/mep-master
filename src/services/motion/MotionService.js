'use strict';
/** @namespace services.motion */

const TaskError = Mep.require('strategy/TaskError');
const EventEmitter = require('events').EventEmitter;
const Point = Mep.require('misc/Point');
const MotionDriver = Mep.require('drivers/motion/MotionDriver');
const MotionTargetQueue = require('./MotionTargetQueue');
const Line = Mep.require('misc/Line');

const TAG = 'MotionService';

/**
 * Provides a very abstract way to control and estimate robot position
 * @fires services.motion.MotionService#pathObstacleDetected
 * @memberOf services.position
 * @author Darko Lukic <lukicdarkoo@gmail.com>
 */
class MotionService extends EventEmitter {
    init(config) {
        this.config = Object.assign({
            hazardObstacleDistance: 200,
            timeToStop: 100,
            maxBypassTolerance: 50,
            targetLineOffset: 200
        }, config);

        this.motionDriver = Mep.DriverManager.getDriver('MotionDriver');

        // Important for simulation
        this._targetQueue = new MotionTargetQueue((targets) => {
            Mep.Telemetry.send(TAG, 'TargetQueueChanged', targets);
        });
        Mep.Telemetry.send(TAG, 'HazardObstacleDistanceSet', {
            hazardObstacleDistance: this.config.hazardObstacleDistance
        });

        // Global resolve and reject used outside (strategies)
        this._resolve = null;
        this._reject = null;

        this._paused = false;
        this._obstacleDetectedTimeout = null;

        // Event method configuration
        this._goToNextQueuedTarget = this._goToNextQueuedTarget.bind(this);
        this._onObstacleDetected = this._onObstacleDetected.bind(this);

        // Subscribe on sensors that can provide obstacles on the robot's terrain
        Mep.Terrain.on('obstacleDetected', this._onObstacleDetected);
    }

    isPaused() {
        return this._paused;
    }

    _onObstacleDetected(poi, polygon) {
        let motionService = this;
        let target = this._targetQueue.getTargetFront();
        if (target === null) return;

        // Generate target line offset
        let offset = new Point(this.config.targetLineOffset, 0);
        offset.rotate(new Point(0, 0), Mep.Position.getOrientation());
        let line = new Line(
            Mep.Position.getPosition().clone().translate(offset),
            target.getPoint().clone().translate(offset)
        );

        // Hazard region
        if (line.isIntersectWithPolygon(polygon) === true) {
            if (poi.getDistance(Mep.Position.getPosition()) < this.config.hazardObstacleDistance) {

                if (this._obstacleDetectedTimeout !== null) {
                    clearTimeout(this._obstacleDetectedTimeout);
                } else {
                    this.emit('pathObstacleDetected', true);
                }

                this._obstacleDetectedTimeout = setTimeout(() => {
                    this._obstacleDetectedTimeout = null;
                    motionService.emit('pathObstacleDetected', false);
                }, Mep.Config.get('obstacleMaxPeriod') + 100);
            } else {
                // Try to redesign a path
                if (target.getParams().rerouting === true) {
                    this.tryRerouting();
                }
            }
        }
    }

    tryRerouting() {
        let motionService = this;

        let pfTarget = this._targetQueue.getTargetBack();
        if (pfTarget !== null) {
            // Redesign path
            let points = Mep.Terrain.findPath(Mep.Position.getPosition(), pfTarget.getPoint());
            if (points.length > 0) {
                let params = pfTarget.getParams();

                // Reduce tolerance to get better to get better bypass
                params.tolerance = (params.tolerance > this.config.maxBypassTolerance) ?
                    this.config.maxBypassTolerance :
                    params.tolerance;

                // Redesign a path
                this._targetQueue.empty();
                this._targetQueue.addPointsBack(points, params);

                if (params.tolerance == -1) {
                    this.stop().then(() => {
                        motionService.resume();
                    });
                } else {
                    this.motionDriver.finishCommand();
                    this.resume();
                }
            } else {
                Mep.Log.warn(TAG, 'Cannot redesign path, possible crash!');
                // There will be no crash if obstacle move away or
                // if robot stop thanks to `pathObstacleDetected` sensors
            }
        }
    }

    /**
     * Move the robot, set new position of the robot
     *
     * @param {TunedPoint} tunedPoint - Point that should be reached
     * @param {Boolean} parameters.pf - Use terrain finding algorithm
     * @param {Boolean} parameters.backward - Enable backward robot moving
     * @param {Boolean} params.rerouting - Enable rerouting during the movement
     * @param {Boolean} parameters.relative - Use relative to previous position
     * @param {Number} parameters.tolerance - Position will consider as reached if Euclid's distance between current
     * and required position is less than tolerance
     * @param {Number} parameters.speed - Speed of the robot movement in range (0, 255)
     * @returns {Promise}
     */
    go(tunedPoint, parameters) {
        let point = tunedPoint.getPoint();
        let params = Object.assign({}, this.config.moveOptions, parameters);

        this._targetQueue.empty();

        // Apply relative
        if (params.relative === true) {
            point.translate(Mep.Position.getPosition());
        }

        // Apply path finding algorithm
        if (params.pf === true) {
            let currentPoint = Mep.Position.getPosition();
            this._targetQueue.addPointsBack(Mep.Terrain.findPath(currentPoint, point), params);
            Mep.Log.debug(TAG, 'Start path finding from', currentPoint, 'to', this._targetQueue.getTargets());
        } else {
            this._targetQueue.addPointBack(point, params)
        }

        return new Promise((resolve, reject) => {
            if (this._targetQueue.isEmpty()) {
                reject(new TaskError(TAG, 'PathFinding', 'Cannot go to required position, no path found'));
                return;
            }
            this._resolve = resolve;
            this._reject = reject;
            this._goToNextQueuedTarget();
        });
    }

    _goToNextQueuedTarget() {
        let motionService = this;
        if (this._targetQueue.isEmpty()) {
            this._resolve();
        } else {
            let target = this._targetQueue.getTargetFront();
            this._goSingleTarget(target.getPoint(), target.getParams()).then(() => {
                motionService._targetQueue.removeFront();
                motionService._goToNextQueuedTarget();
            }).catch((e) => {
                if (e.action !== 'break') {
                    motionService._reject(e);
                }
            });
        }
    }

    /**
     * Go to single point without advanced features
     * @param point {misc.Point} - Target point
     * @param params.backward {Boolean} - Move robot backward
     * @param params.tolerance {Number} - Max radius
     * @param params.speed {Number} - Speed
     * @return {Promise}
     * @private
     */
    _goSingleTarget(point, params) {
        Mep.Log.debug(TAG, 'Simple target go',  point);
        this._paused = false;

        // Set speed
        if (params.speed !== undefined && this.motionDriver.getActiveSpeed() !== params.speed) {
            this.motionDriver.setSpeed(params.speed);
        }

        // Move the robot
        if (params.tolerance < 0) {
            return this.motionDriver.moveToPosition(
                point,
                params.backward ? -1 : 1
            );
        } else {
            return this.motionDriver.moveToCurvilinear(
                point,
                params.backward ? -1 : 1,
                params.tolerance
            );
        }
    }

    /**
     * Stop the robot
     * @param softStop - If true robot will turn of motors
     */
    stop(softStop = false) {
        this.pause();
        if (softStop === true) {
            return this.motionDriver.softStop();
        } else {
            return this.motionDriver.stop();
        }
    }


    pause() {
        this._paused = true;
    }

    resume() {
        if (this._paused === true) {
            this._paused = false;
            this._goToNextQueuedTarget();
        }
    }

    /**
     * Move robot forward or backward depending on param `millimeters`
     * @param millimeters {Number} - Path that needs to be passed. If negative robot will go backward
     * @returns {Promise}
     */
    straight(millimeters) {
        return this.motionDriver.goForward(millimeters | 0);
    }

    /**
     * Rotate robot for an angle
     * @param tunedAngle {TunedAngle} - Angle to rotate
     * @param options {Object} - Additional options
     * @returns {Promise}
     */
    rotate(tunedAngle, options) {
        return this.motionDriver.rotateTo(tunedAngle.getAngle());
    }
}

module.exports = MotionService;