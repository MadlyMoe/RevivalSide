plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

dependencies {
    implementation(project(":shared"))
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

android {
    namespace = "dev.revivalside.officialprofilecapture"
    compileSdk = 36
    ndkVersion = "27.2.12479018"

    defaultConfig {
        applicationId = "dev.revivalside.officialprofilecapture"
        minSdk = 26
        targetSdk = 36
        versionCode = 3
        versionName = "0.4.0"

        ndk {
            abiFilters += listOf("armeabi-v7a", "arm64-v8a")
        }

        externalNativeBuild {
            cmake {
                arguments += "-DANDROID_STL=c++_shared"
            }
        }
    }

    val releaseKeystore = providers.environmentVariable("REVIVALSIDE_ANDROID_KEYSTORE").orNull
    val releaseKeyAlias = providers.environmentVariable("REVIVALSIDE_ANDROID_KEY_ALIAS").orNull
    val releaseStorePassword = providers.environmentVariable("REVIVALSIDE_ANDROID_KEYSTORE_PASSWORD").orNull
    val releaseKeyPassword = providers.environmentVariable("REVIVALSIDE_ANDROID_KEY_PASSWORD").orNull
    if (listOf(releaseKeystore, releaseKeyAlias, releaseStorePassword, releaseKeyPassword).all { !it.isNullOrBlank() }) {
        signingConfigs {
            create("release") {
                storeFile = file(releaseKeystore!!)
                storePassword = releaseStorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
        buildTypes.getByName("release").signingConfig = signingConfigs.getByName("release")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    externalNativeBuild {
        cmake {
            path = file("CMakeLists.txt")
        }
    }

    sourceSets {
        getByName("main") {
            jniLibs.srcDirs("libnode/bin", "src/main/jniLibs")
        }
    }

    androidResources {
        noCompress += listOf("zip")
    }

    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
}
