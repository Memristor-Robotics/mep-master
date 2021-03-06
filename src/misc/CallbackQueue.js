'use strict';

/** @namespace misc */

const TAG = 'CallbackQueue';

/**
 * Queue of callback functions. It used when you want to allow other modules to subscribe to your events.
 *
 * @deprecated
 * @author Darko Lukic <lukicdarkoo@gmail.com>
 * @memberOf misc
 */
class CallbackQueue {
    constructor() {
        this.callbacks = [];
    }

    /**
     * Subscribe on event. Add callback function to queue.
     * @param {function} callback - Pointer on callback function
     */
    add(callback) {
        this.callbacks.push(callback);
    }

    /**
     * Call all callback functions from queue with same parameters.
     * @param {Array} params - Params which will passed to callback functions
     */
    notifyAll(params) {
        if (Array.isArray(params) == false) {
            Mep.Log.error(TAG, 'notifyAll() expect array only');
            return;
        }

        this.callbacks.forEach(function (callback) {
            callback(...params);
        });
    }
}

module.exports = CallbackQueue;
