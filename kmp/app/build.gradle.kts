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

    defaultConfig {
        applicationId = "dev.revivalside.officialprofilecapture"
        minSdk = 26
        targetSdk = 36
        versionCode = 2
        versionName = "0.3.5a"

        ndk {
            abiFilters += listOf("armeabi-v7a", "arm64-v8a", "x86_64")
        }

        externalNativeBuild {
            cmake {
                arguments += "-DANDROID_STL=c++_shared"
            }
        }
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
