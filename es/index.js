import isRetryAllowed from 'is-retry-allowed';

const namespace = 'axios-retry';

/**
 * @param  {Error}  error
 * @return {boolean}
 */
export function isNetworkError(error) {
  return (
    !error.response &&
    Boolean(error.code) && // Prevents retrying cancelled requests
    error.code !== 'ECONNABORTED' && // Prevents retrying timed out requests
    isRetryAllowed(error)
  ); // Prevents retrying unsafe errors
}

const SAFE_HTTP_METHODS = ['get', 'head', 'options'];
const IDEMPOTENT_HTTP_METHODS = SAFE_HTTP_METHODS.concat(['put', 'delete']);

/**
 * @param  {Error}  error
 * @return {boolean}
 */
export function isRetryableError(error) {
  return (
    error.code !== 'ECONNABORTED' &&
    (!error.response ||
      (error.response.status >= 500 && error.response.status <= 599) ||
      error.response.status === 429)
  );
}

/**
 * @param  {Error}  error
 * @return {boolean}
 */
export function isSafeRequestError(error) {
  if (!error.config) {
    // Cannot determine if the request can be retried
    return false;
  }

  return isRetryableError(error) && SAFE_HTTP_METHODS.indexOf(error.config.method) !== -1;
}

/**
 * @param  {Error}  error
 * @return {boolean}
 */
export function isIdempotentRequestError(error) {
  if (!error.config) {
    // Cannot determine if the request can be retried
    return false;
  }

  return isRetryableError(error) && IDEMPOTENT_HTTP_METHODS.indexOf(error.config.method) !== -1;
}

/**
 * @param  {Error}  error
 * @return {boolean}
 */
export function isNetworkOrIdempotentRequestError(error) {
  return isNetworkError(error) || isIdempotentRequestError(error);
}

/**
 * @return {number} - delay in milliseconds, always 0
 */
function noDelay() {
  return 0;
}

/**
 * @param  {number} [retryNumber=0]
 * @return {number} - delay in milliseconds
 */
export function exponentialDelay(retryNumber = 0) {
  const delay = Math.pow(2, retryNumber) * 100;
  const randomSum = delay * 0.2 * Math.random(); // 0-20% of the delay
  return delay + randomSum;
}

/**
 * @param  {number} [retryNumber]
 * @param  {Error}  [error]
 * @return {number} - delay in milliseconds
 */
export function retryAfter(retryNumber, error) {
  if (error.response) {
    const retry_after = error.response.headers["retry-after"];
    if (retry_after) {
      const retry_after_secs = parseInt(retry_after, 10);
      if (!isNaN(retry_after_secs)) {
        return retry_after_secs * 1000;
      } else {
        const retry_date_ms = Date.parse(retry_after);
        if (isNaN(retry_date_ms)) {
          throw Error("Unexpected Retry-After value: " + retry_date_ms);
        }

        const delta_ms = retry_date_ms - Date.now();
        return delta_ms;
      }
    }
  }
  return 0;
}

/**
 * Initializes and returns the retry state for the given request/config
 * @param  {AxiosRequestConfig} config
 * @return {Object}
 */
function getCurrentState(config) {
  const currentState = config[namespace] || {};
  currentState.retryCount = currentState.retryCount || 0;
  config[namespace] = currentState;
  return currentState;
}

/**
 * Returns the axios-retry options for the current request
 * @param  {AxiosRequestConfig} config
 * @param  {AxiosRetryConfig} defaultOptions
 * @return {AxiosRetryConfig}
 */
function getRequestOptions(config, defaultOptions) {
  return Object.assign({}, defaultOptions, config[namespace]);
}

/**
 * @param  {Axios} axios
 * @param  {AxiosRequestConfig} config
 */
function fixConfig(axios, config) {
  if (axios.defaults.agent === config.agent) {
    delete config.agent;
  }
  if (axios.defaults.httpAgent === config.httpAgent) {
    delete config.httpAgent;
  }
  if (axios.defaults.httpsAgent === config.httpsAgent) {
    delete config.httpsAgent;
  }
}

/**
 * Adds response interceptors to an axios instance to retry requests failed due to network issues
 *
 * @example
 *
 * import axios from 'axios';
 *
 * axiosRetry(axios, { retries: 3 });
 *
 * axios.get('http://example.com/test') // The first request fails and the second returns 'ok'
 *   .then(result => {
 *     result.data; // 'ok'
 *   });
 *
 * // Exponential back-off retry delay between requests
 * axiosRetry(axios, { retryDelay : axiosRetry.exponentialDelay});
 *
 * // Custom retry delay
 * axiosRetry(axios, { retryDelay : (retryCount) => {
 *   return retryCount * 1000;
 * }});
 *
 * // Custom retry which checks Retry-After header against limit
 * axiosRetry(axios, { retryDelay : (retryCount, error) => {
 *   if (error.response) {
 *     const retry_after = error.response.headers["retry-after"];
 *     if (retry_after) {
 *       let retry_after_ms = 0;
 *       const retry_after_secs = parseInt(retry_after, 10);
 *       if (!isNaN(retry_after_secs)) {
 *         retry_after_ms = retry_after_secs * 1000;
 *       } else {
 *         const retry_date_ms = Date.parse(retry_after);
 *         if (isNaN(retry_date_ms)) {
 *           throw Error("Unexpected Retry-After value: " + retry_date_ms);
 *         }
 * 
 *         retry_after_ms = retry_date_ms - Date.now();
 *       }
 * 
 *       // check if retry is less than 5 seconds
 *       if (retry_after_ms <= 5000) {
 *         return retry_after_ms;
 *       } else {
 *         // return negative value to prevent retry
 *         return -1;
 *       }
 *     }
 *   }
 *   return 0;
 * }});
 *
 * // Also works with custom axios instances
 * const client = axios.create({ baseURL: 'http://example.com' });
 * axiosRetry(client, { retries: 3 });
 *
 * client.get('/test') // The first request fails and the second returns 'ok'
 *   .then(result => {
 *     result.data; // 'ok'
 *   });
 *
 * // Allows request-specific configuration
 * client
 *   .get('/test', {
 *     'axios-retry': {
 *       retries: 0
 *     }
 *   })
 *   .catch(error => { // The first request fails
 *     error !== undefined
 *   });
 *
 * @param {Axios} axios An axios instance (the axios object or one created from axios.create)
 * @param {Object} [defaultOptions]
 * @param {number} [defaultOptions.retries=3] Number of retries
 * @param {boolean} [defaultOptions.shouldResetTimeout=false]
 *        Defines if the timeout should be reset between retries
 * @param {Function} [defaultOptions.retryCondition=isNetworkOrIdempotentRequestError]
 *        A function to determine if the error can be retried
 * @param {Function} [defaultOptions.retryDelay=noDelay]
 *        A function to determine the delay between retry requests
 */
export default function axiosRetry(axios, defaultOptions) {
  axios.interceptors.request.use(config => {
    const currentState = getCurrentState(config);
    currentState.lastRequestTime = Date.now();
    return config;
  });

  axios.interceptors.response.use(null, error => {
    const config = error.config;

    // If we have no information to retry the request
    if (!config) {
      return Promise.reject(error);
    }

    const {
      retries = 3,
      retryCondition = isNetworkOrIdempotentRequestError,
      retryDelay = noDelay,
      shouldResetTimeout = false
    } = getRequestOptions(config, defaultOptions);

    const currentState = getCurrentState(config);

    const shouldRetry = retryCondition(error) && currentState.retryCount < retries;

    if (shouldRetry) {
      currentState.retryCount += 1;
      const delay = retryDelay(currentState.retryCount, error);
      if (delay >= 0) {
        // Axios fails merging this configuration to the default configuration because it has an issue
        // with circular structures: https://github.com/mzabriskie/axios/issues/370
        fixConfig(axios, config);

        if (!shouldResetTimeout && config.timeout && currentState.lastRequestTime) {
          const lastRequestDuration = Date.now() - currentState.lastRequestTime;
          // Minimum 1ms timeout (passing 0 or less to XHR means no timeout)
          config.timeout = Math.max(config.timeout - lastRequestDuration - delay, 1);
        }

        config.transformRequest = [data => data];

        return new Promise((resolve) => setTimeout(() => resolve(axios(config)), delay));
      }
    }

    return Promise.reject(error);
  });
}

// Compatibility with CommonJS
axiosRetry.isNetworkError = isNetworkError;
axiosRetry.isSafeRequestError = isSafeRequestError;
axiosRetry.isIdempotentRequestError = isIdempotentRequestError;
axiosRetry.isNetworkOrIdempotentRequestError = isNetworkOrIdempotentRequestError;
axiosRetry.exponentialDelay = exponentialDelay;
axiosRetry.retryAfter = retryAfter;
axiosRetry.isRetryableError = isRetryableError;
