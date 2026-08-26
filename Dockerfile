# Explicit upstream Node 20 Alpine variant instead of the mutable umbrella tag.
FROM node:20-alpine3.23

WORKDIR /app

# The build runs on a persistent BuildKit builder, so this layer would other-
# wise be reused forever and stop picking up new OpenSSL patches. CI passes a
# fresh APK_UPGRADE_DATE each day; referencing it here busts the layer.
ARG APK_UPGRADE_DATE=unset
RUN echo "apk upgrade ${APK_UPGRADE_DATE}" >/dev/null \
 && apk upgrade --no-cache libcrypto3 libssl3

# Database migration and import jobs execute psql from this same final image.
# Pin the client package so the job contract does not drift with the Alpine repo.
RUN apk add --no-cache postgresql16-client=16.10-r0 \
 && command -v psql

COPY package.json package-lock.json ./
# The cache mount keeps npm's package tarballs between builds, so a lockfile
# change re-links from disk instead of re-downloading every dependency (737s
# in job 14117). `npm ci` still wipes node_modules and installs exactly what
# package-lock.json pins. sharing=locked serialises concurrent builds.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --prefer-offline --no-audit --no-fund

COPY . .

ENV NEXT_STANDALONE=false
RUN npm run build

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

# npm is only needed while building. Removing it from the runtime image also
# removes its bundled tar dependency, which is not used by the application.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

# The application does not need to write to the image filesystem at runtime.
# Keep the image compatible with a read-only root filesystem and mount /tmp in
# the CCE workload for the small amount of temporary space Node may need.
RUN chown -R node:node /app
USER node

EXPOSE 3000

CMD ["node", "node_modules/next/dist/bin/next", "start"]
